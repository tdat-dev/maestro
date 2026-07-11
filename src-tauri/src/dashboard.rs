//! Local web dashboard — a tiny read-only HTTP view of the agent fleet that the
//! user can open from another device on the same network, plus a "send a
//! message to an agent" POST that hands off to the frontend.
//!
//! The fleet state lives in the JS frontend, so the frontend pushes a JSON
//! snapshot here (`dashboard_push`) on each fleet tick; the HTTP server serves
//! that snapshot. A POST /api/send emits a `dashboard-send` event the frontend
//! turns into a keystroke to the target pane. Bound to localhost by default;
//! LAN (0.0.0.0) is opt-in since the send endpoint can drive an agent.

use std::io::Read;
use std::net::{Ipv4Addr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::core::registry::Registry;
use crate::error::{run_blocking, CommandError};
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
    urls: Vec<String>, // computed once at start (off the main thread), then cached
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
// xterm.js bundled + served same-origin so the full web terminal works offline.
const XTERM_JS: &str = include_str!("../../node_modules/@xterm/xterm/lib/xterm.js");
const XTERM_CSS: &str = include_str!("../../node_modules/@xterm/xterm/css/xterm.css");
const ADDON_FIT_JS: &str = include_str!("../../node_modules/@xterm/addon-fit/lib/addon-fit.js");

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
        // Cached — never call local_ip() here (this runs on the UI thread).
        urls: if inner.running { inner.urls.clone() } else { vec![] },
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
pub async fn dashboard_start(
    app: AppHandle,
    state: State<'_, AppState>,
    port: u16,
    lan: bool,
) -> Result<DashboardInfo, CommandError> {
    // Grab what the server thread needs WITHOUT holding a lock across an await.
    let snapshot = state.dashboard.inner.lock().unwrap().snapshot.clone();
    let registry = state.registry.clone();
    // Stop any previous server before rebinding.
    if let Some(stop) = state.dashboard.inner.lock().unwrap().stop.take() {
        stop.store(true, Ordering::SeqCst);
    }

    // Binding to 0.0.0.0 (LAN) and probing the local IP can block; do it OFF the
    // main/UI thread so toggling LAN never freezes the app.
    let bind = if lan { Ipv4Addr::UNSPECIFIED } else { Ipv4Addr::LOCALHOST };
    let (server, urls) = run_blocking(move || {
        let server = Server::http((bind, port)).map_err(|e| {
            CommandError::Failed(format!("dashboard: cannot bind port {port}: {e}"))
        })?;
        Ok((server, urls_for(port, lan)))
    })
    .await?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let app_thread = app.clone();
    std::thread::spawn(move || serve(server, snapshot, stop_thread, app_thread, registry));

    let mut inner = state.dashboard.inner.lock().unwrap();
    inner.running = true;
    inner.port = port;
    inner.lan = lan;
    inner.urls = urls;
    inner.stop = Some(stop);
    Ok(info(&inner))
}

fn json_response(body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    Response::from_string(body).with_header(header)
}

fn header(name: &[u8], value: &[u8]) -> Header {
    Header::from_bytes(name, value).unwrap()
}

fn respond_404(request: Request) {
    let _ = request.respond(Response::from_string("not found").with_status_code(404));
}

/// Serve a bundled static asset (xterm.js / css) with a content type.
fn asset(request: Request, body: &'static str, mime: &[u8]) {
    let _ = request.respond(Response::from_string(body).with_header(header(b"Content-Type", mime)));
}

/// Extract `id` from a `?id=...&...` query string.
fn query_id(url: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|p| p.strip_prefix("id=").map(|v| v.to_string()))
}

fn read_body(request: &mut Request) -> serde_json::Value {
    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);
    serde_json::from_str(&body).unwrap_or(serde_json::Value::Null)
}

fn serve(
    server: Server,
    snapshot: Arc<Mutex<String>>,
    stop: Arc<AtomicBool>,
    app: AppHandle,
    registry: Arc<Mutex<Registry>>,
) {
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        // Timeout so the stop flag is checked even with no traffic.
        let request = match server.recv_timeout(Duration::from_millis(500)) {
            Ok(Some(r)) => r,
            Ok(None) => continue,
            Err(_) => break,
        };
        // One thread per request: a /term SSE stream holds its connection open
        // for the life of the terminal, so it must not block the accept loop.
        let (snapshot, app, registry) = (snapshot.clone(), app.clone(), registry.clone());
        std::thread::spawn(move || handle(request, snapshot, app, registry));
    }
}

fn handle(
    mut request: Request,
    snapshot: Arc<Mutex<String>>,
    app: AppHandle,
    registry: Arc<Mutex<Registry>>,
) {
    let url = request.url().to_string();
    let method = request.method().clone();
    let path = url.split('?').next().unwrap_or("").to_string();

    match (method, path.as_str()) {
        (Method::Get, "/") => {
            let ct = header(b"Content-Type", b"text/html; charset=utf-8");
            // No-cache so a rebuilt page always loads fresh on refresh.
            let nc = header(b"Cache-Control", b"no-cache, no-store");
            let _ = request.respond(Response::from_string(PAGE).with_header(ct).with_header(nc));
        }
        (Method::Get, "/xterm.js") => asset(request, XTERM_JS, b"application/javascript"),
        (Method::Get, "/addon-fit.js") => asset(request, ADDON_FIT_JS, b"application/javascript"),
        (Method::Get, "/xterm.css") => asset(request, XTERM_CSS, b"text/css"),
        (Method::Get, "/api/fleet") => {
            let body = snapshot.lock().unwrap().clone();
            let body = if body.is_empty() { "{\"agents\":[]}".to_string() } else { body };
            let _ = request.respond(json_response(body));
        }
        (Method::Post, "/api/send") => {
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);
            // Forward the raw JSON to the frontend, which validates + delivers.
            let _ = app.emit("dashboard-send", body);
            let _ = request.respond(json_response("{\"ok\":true}".into()));
        }
        // Full web terminal: SSE output stream + raw input + resize.
        (Method::Get, "/term") => sse_terminal(request, registry, query_id(&url)),
        (Method::Post, "/term/input") => {
            let v = read_body(&mut request);
            if let (Some(id), Some(data)) = (
                v.get("id").and_then(|x| x.as_str()),
                v.get("data").and_then(|x| x.as_str()),
            ) {
                if let Ok(bytes) = STANDARD.decode(data) {
                    let _ = registry.lock().unwrap().write_input(id, &bytes);
                }
            }
            let _ = request.respond(json_response("{\"ok\":true}".into()));
        }
        (Method::Post, "/term/resize") => {
            let v = read_body(&mut request);
            if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                let cols = v.get("cols").and_then(|x| x.as_u64()).unwrap_or(80) as u16;
                let rows = v.get("rows").and_then(|x| x.as_u64()).unwrap_or(24) as u16;
                let _ = registry.lock().unwrap().resize(id, cols, rows);
            }
            let _ = request.respond(json_response("{\"ok\":true}".into()));
        }
        _ => respond_404(request),
    }
}

/// Stream an agent's live output to the browser as Server-Sent Events. Each PTY
/// chunk is base64-encoded into one `data:` frame; xterm.js decodes and writes
/// it. Blocks in its own thread until the agent exits or the client disconnects.
fn sse_terminal(request: Request, registry: Arc<Mutex<Registry>>, id: Option<String>) {
    let id = match id {
        Some(i) => i,
        None => return respond_404(request),
    };
    let rx = match registry.lock().unwrap().tap(&id) {
        Ok(r) => r,
        Err(_) => return respond_404(request),
    };
    let headers = vec![
        header(b"Content-Type", b"text/event-stream"),
        header(b"Cache-Control", b"no-cache"),
    ];
    let reader = SseReader { rx, pending: Vec::new(), pos: 0 };
    // data_length None → chunked transfer, streamed as the reader yields.
    let resp = Response::new(StatusCode(200), headers, reader, None, None);
    let _ = request.respond(resp);
}

/// A blocking `Read` that turns an agent's output channel into an SSE byte
/// stream. Reads block on the channel; a closed channel (agent gone) ends it.
struct SseReader {
    rx: Receiver<Vec<u8>>,
    pending: Vec<u8>,
    pos: usize,
}
impl Read for SseReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.pending.len() {
            match self.rx.recv() {
                Ok(chunk) => {
                    // tiny_http wraps the socket in a 1024-byte BufWriter and only
                    // flushes when it fills or the response ends — but an SSE stream
                    // never ends, so small frames (a keystroke echo) stall in the
                    // buffer. Pad each frame past 1 KB with an ignored `:` comment
                    // line so every frame overflows the buffer and flushes at once.
                    let mut frame = format!("data: {}\n", STANDARD.encode(&chunk));
                    const MIN: usize = 1500;
                    let l = frame.len();
                    if l + 3 < MIN {
                        frame.push(':');
                        frame.push_str(&" ".repeat(MIN - l - 3));
                        frame.push('\n');
                    }
                    frame.push('\n');
                    self.pending = frame.into_bytes();
                    self.pos = 0;
                }
                Err(_) => return Ok(0), // agent exited → EOF closes the stream
            }
        }
        let n = std::cmp::min(out.len(), self.pending.len() - self.pos);
        out[..n].copy_from_slice(&self.pending[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}
