//! Local web dashboard — a tiny read-only HTTP view of the agent fleet that the
//! user can open from another device on the same network, plus a "send a
//! message to an agent" POST that hands off to the frontend.
//!
//! The fleet state lives in the JS frontend, so the frontend pushes a JSON
//! snapshot here (`dashboard_push`) on each fleet tick; the HTTP server serves
//! that snapshot. A POST /api/send emits a `dashboard-send` event the frontend
//! turns into a keystroke to the target pane. Bound to localhost by default;
//! LAN (0.0.0.0) is opt-in since the send endpoint can drive an agent.

use std::net::{Ipv4Addr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tiny_http::{Header, Method, Response, Server};

use crate::error::CommandError;
use crate::state::AppState;

#[derive(Default)]
pub struct Dashboard {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    running: bool,
    port: u16,
    lan: bool,
    snapshot: Arc<Mutex<String>>,
    stop: Option<Arc<AtomicBool>>,
}

#[derive(Serialize, Clone)]
pub struct DashboardInfo {
    pub running: bool,
    pub port: u16,
    pub lan: bool,
    pub urls: Vec<String>,
}

const PAGE: &str = include_str!("dashboard.html");

/// Best-effort primary LAN IPv4 (no packet is actually sent — the connect just
/// picks the outbound interface). None if it can't be determined.
fn local_ip() -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    match sock.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(v4) => Some(v4),
        _ => None,
    }
}

fn urls_for(port: u16, lan: bool) -> Vec<String> {
    let mut out = vec![format!("http://127.0.0.1:{port}")];
    if lan {
        if let Some(ip) = local_ip() {
            out.push(format!("http://{ip}:{port}"));
        }
    }
    out
}

fn info(inner: &Inner) -> DashboardInfo {
    DashboardInfo {
        running: inner.running,
        port: inner.port,
        lan: inner.lan,
        urls: if inner.running {
            urls_for(inner.port, inner.lan)
        } else {
            vec![]
        },
    }
}

#[tauri::command]
pub fn dashboard_status(state: State<'_, AppState>) -> DashboardInfo {
    info(&state.dashboard.inner.lock().unwrap())
}

/// Store the latest fleet snapshot JSON the HTTP server serves at /api/fleet.
#[tauri::command]
pub fn dashboard_push(state: State<'_, AppState>, snapshot: String) {
    let inner = state.dashboard.inner.lock().unwrap();
    *inner.snapshot.lock().unwrap() = snapshot;
}

#[tauri::command]
pub fn dashboard_stop(state: State<'_, AppState>) -> DashboardInfo {
    let mut inner = state.dashboard.inner.lock().unwrap();
    if let Some(stop) = inner.stop.take() {
        stop.store(true, Ordering::SeqCst);
    }
    inner.running = false;
    info(&inner)
}

#[tauri::command]
pub fn dashboard_start(
    app: AppHandle,
    state: State<'_, AppState>,
    port: u16,
    lan: bool,
) -> Result<DashboardInfo, CommandError> {
    let mut inner = state.dashboard.inner.lock().unwrap();
    // Restart cleanly if already running (e.g. port/lan changed).
    if let Some(stop) = inner.stop.take() {
        stop.store(true, Ordering::SeqCst);
    }
    let bind = if lan { Ipv4Addr::UNSPECIFIED } else { Ipv4Addr::LOCALHOST };
    let server = Server::http((bind, port))
        .map_err(|e| CommandError::Failed(format!("dashboard: cannot bind port {port}: {e}")))?;

    let snapshot = inner.snapshot.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let app_thread = app.clone();
    std::thread::spawn(move || serve(server, snapshot, stop_thread, app_thread));

    inner.running = true;
    inner.port = port;
    inner.lan = lan;
    inner.stop = Some(stop);
    Ok(info(&inner))
}

fn json_response(body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    Response::from_string(body).with_header(header)
}

fn serve(server: Server, snapshot: Arc<Mutex<String>>, stop: Arc<AtomicBool>, app: AppHandle) {
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        // Timeout so the stop flag is checked even with no traffic.
        let mut request = match server.recv_timeout(Duration::from_millis(500)) {
            Ok(Some(r)) => r,
            Ok(None) => continue,
            Err(_) => break,
        };
        let url = request.url().to_string();
        let method = request.method().clone();

        if method == Method::Get && (url == "/" || url.starts_with("/?")) {
            let ct = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
                .unwrap();
            // No-cache so a rebuilt page always loads fresh on refresh.
            let nc = Header::from_bytes(&b"Cache-Control"[..], &b"no-cache, no-store"[..]).unwrap();
            let _ = request.respond(Response::from_string(PAGE).with_header(ct).with_header(nc));
        } else if method == Method::Get && url == "/api/fleet" {
            let body = snapshot.lock().unwrap().clone();
            let body = if body.is_empty() { "{\"agents\":[]}".to_string() } else { body };
            let _ = request.respond(json_response(body));
        } else if method == Method::Post && url == "/api/send" {
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);
            // Forward the raw JSON to the frontend, which validates + delivers.
            let _ = app.emit("dashboard-send", body);
            let _ = request.respond(json_response("{\"ok\":true}".into()));
        } else {
            let _ = request.respond(Response::from_string("not found").with_status_code(404));
        }
    }
}
