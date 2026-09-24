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
    match hub::Hub::start(Box::new(move |list| {
        let _ = app2.emit("browser-hub", list);
    })) {
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
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let local = std::env::var("LOCALAPPDATA").map_err(|e| e.to_string())?;
    let dir = std::path::PathBuf::from(local).join("Maestro").join("NativeHost");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
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
