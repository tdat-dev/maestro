//! Maestro for Chrome: agents use the user's real browsers through an
//! extension, the way Claude in Chrome does.
//!
//! ```text
//! agent → maestro-mcp ─ws─┐
//!                         ├─ hub (in Maestro)
//! extension ─ native ─────┘
//!           messaging → maestro.exe host ─ws─
//! ```
//!
//! See docs/superpowers/specs/2026-09-24-maestro-browser-design.md.

pub mod host;
pub mod hub;
pub mod profiles;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// The extension's fixed id (from the public `key` in its manifest).
pub const EXTENSION_ID: &str = "lhnncnhgomngapalcfncgehffmmibmbf";
pub const HOST_NAME: &str = "com.maestro.browser";

#[derive(Default)]
pub struct BrowserState {
    hub: Mutex<Option<Arc<hub::Hub>>>,
}

#[derive(Serialize)]
pub struct BrowserStatus {
    running: bool,
    port: u16,
    browsers: Vec<hub::BrowserInfo>,
    extension_id: &'static str,
    extension_dir: String,
}

/// Start the hub and (re)register the native host. Called once at startup.
pub fn start(app: &AppHandle, state: &BrowserState) {
    let app2 = app.clone();
    let wanted = std::fs::read_to_string(std::path::Path::new(&extension_dir()).join("manifest.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["version"].as_str().map(String::from));
    match hub::Hub::start(Box::new(move |ev| {
        let _ = match ev {
            hub::HubEvent::Browsers(list) => app2.emit("browser-hub", list),
            hub::HubEvent::Activity(list) => app2.emit("browser-activity", list),
            hub::HubEvent::Asks(list) => app2.emit("browser-asks", list),
            hub::HubEvent::Blocker(b) => app2.emit("browser-blocker", b),
        };
    }), wanted) {
        Ok(h) => *state.hub.lock().unwrap() = Some(h),
        Err(e) => eprintln!("browser hub: {e}"),
    }
    std::thread::spawn(|| {
        if let Err(e) = register_host() {
            eprintln!("browser host registration: {e}");
        }
    });
}

/// Where the unpacked extension lives: next to the app when installed,
/// the repo's `browser-extension/` in development.
pub fn extension_dir() -> String {
    let exe = std::env::current_exe().ok();
    let beside = exe.as_ref().and_then(|e| e.parent()).map(|d| d.join("browser-extension"));
    if let Some(d) = beside.filter(|d| d.join("manifest.json").exists()) {
        return d.to_string_lossy().into_owned();
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("browser-extension");
    dunce_like(dev)
}

fn dunce_like(p: std::path::PathBuf) -> String {
    std::fs::canonicalize(&p)
        .map(|c| c.to_string_lossy().trim_start_matches(r"\\?\").to_string())
        .unwrap_or_else(|_| p.to_string_lossy().into_owned())
}

/// Write the host manifest and point every Chromium browser's HKCU key at it,
/// as Claude Code does for its own extension.
#[cfg(windows)]
fn register_host() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let local = std::env::var("LOCALAPPDATA").map_err(|e| e.to_string())?;
    let dir = std::path::PathBuf::from(local).join("Maestro").join("NativeHost");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let exe = host_copy(&dir)?;
    let manifest = dir.join(format!("{HOST_NAME}.json"));
    let body = serde_json::json!({
        "name": HOST_NAME,
        "description": "Maestro browser bridge",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    });
    std::fs::write(&manifest, serde_json::to_string_pretty(&body).unwrap()).map_err(|e| e.to_string())?;
    for vendor in [r"Google\Chrome", r"Microsoft\Edge", r"BraveSoftware\Brave-Browser", r"Chromium", r"Vivaldi"] {
        let key = format!(r"HKCU\Software\{vendor}\NativeMessagingHosts\{HOST_NAME}");
        let _ = std::process::Command::new("reg")
            .args(["add", &key, "/ve", "/t", "REG_SZ", "/d", &manifest.to_string_lossy(), "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    Ok(())
}

/// Chrome keeps the host running for as long as the extension is connected,
/// which is always. If the host were maestro.exe itself, that would lock the
/// file, and neither an update nor a dev rebuild could replace it. So the host
/// is a copy, named after the build it came from. A new build writes a new
/// copy beside the old one, which Chrome is still running; old copies are
/// removed once they are no longer locked.
#[cfg(windows)]
fn host_copy(dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&exe).map_err(|e| e.to_string())?;
    let stamp = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let name = format!("maestro-host-{:x}-{:x}.exe", meta.len(), stamp);
    let copy = dir.join(&name);
    if !copy.exists() {
        let tmp = dir.join(format!("{name}.part"));
        std::fs::copy(&exe, &tmp).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &copy).map_err(|e| e.to_string())?;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.starts_with("maestro-host-") && n != name {
                let _ = std::fs::remove_file(e.path()); // fails while Chrome still runs it
            }
        }
    }
    Ok(copy)
}

#[cfg(not(windows))]
fn register_host() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn browser_status(state: State<'_, BrowserState>) -> BrowserStatus {
    let hub = state.hub.lock().unwrap().clone();
    BrowserStatus {
        running: hub.is_some(),
        port: hub.as_ref().map(|h| h.port).unwrap_or(0),
        browsers: hub.map(|h| h.browsers()).unwrap_or_default(),
        extension_id: EXTENSION_ID,
        extension_dir: extension_dir(),
    }
}

#[tauri::command]
pub fn browser_profiles() -> Vec<profiles::ProfileRow> {
    profiles::all_profiles()
}

/// Open a window of one of the user's profiles, so they can add the extension
/// there.
#[tauri::command]
pub fn browser_open_profile(browser: String, dir: String) -> Result<(), String> {
    let exe = profiles::browser_exe(&browser).ok_or_else(|| format!("{browser} isn't installed where Maestro looked."))?;
    std::process::Command::new(exe)
        .arg(format!("--profile-directory={dir}"))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn hub_of(state: &State<'_, BrowserState>) -> Result<Arc<hub::Hub>, String> {
    state.hub.lock().unwrap().clone().ok_or_else(|| "The browser hub isn't running.".to_string())
}

#[tauri::command]
pub fn browser_activity(state: State<'_, BrowserState>) -> Vec<hub::Activity> {
    state.hub.lock().unwrap().as_ref().map(|h| h.activity()).unwrap_or_default()
}

#[tauri::command]
pub fn browser_pause(state: State<'_, BrowserState>, agent: String, paused: bool) -> Result<(), String> {
    hub_of(&state)?.set_paused(&agent, paused);
    Ok(())
}

/// A small frame of the tab `agent` works in, for the live view.
#[tauri::command]
pub async fn browser_peek(state: State<'_, BrowserState>, agent: String) -> Result<serde_json::Value, String> {
    let hub = hub_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || hub.app_call(&agent, "peek", serde_json::json!({}), std::time::Duration::from_secs(4)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn browser_asks(state: State<'_, BrowserState>) -> Vec<hub::Ask> {
    state.hub.lock().unwrap().as_ref().map(|h| h.asks()).unwrap_or_default()
}

/// The user's answer to a click Maestro held (sending, posting, paying…).
#[tauri::command]
pub fn browser_answer(state: State<'_, BrowserState>, id: u64, ok: bool) -> Result<(), String> {
    hub_of(&state)?.answer(id, ok);
    Ok(())
}

#[tauri::command]
pub fn browser_set_ask(state: State<'_, BrowserState>, on: bool) -> Result<(), String> {
    hub_of(&state)?.set_ask_risky(on);
    Ok(())
}
