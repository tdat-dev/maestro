use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use crate::core::command_spec::CommandSpec;
use crate::error::CommandError;
use crate::state::AppState;
use portable_pty::PtySize;

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
    code: u32,
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    // Raw-bytes channel: PTY output is streamed as binary (ArrayBuffer on the JS
    // side). Sending `Vec<u8>` directly would serialize every byte as a JSON
    // number — pathologically slow under a chatty agent's output and the cause
    // of the whole-app lag when a fleet is producing a lot of terminal output.
    on_bytes: Channel<InvokeResponseBody>,
) -> Result<(), CommandError> {
    let mut spec = CommandSpec::new(program);
    for a in args {
        spec = spec.arg(a);
    }
    spec.cwd = cwd.filter(|s| !s.is_empty());
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let channel = on_bytes.clone();
    let app2 = app.clone();
    let exit_id = agent_id.clone();

    let mut reg = state
        .registry
        .lock()
        .map_err(|_| CommandError::Failed("state poisoned".into()))?;
    reg.spawn(
        agent_id,
        &spec,
        size,
        move |bytes| {
            let _ = channel.send(InvokeResponseBody::Raw(bytes.to_vec()));
        },
        move |code| {
            let _ = app2.emit("pty-exit", ExitPayload { id: exit_id, code });
        },
    )
    .map_err(CommandError::from)
}

#[tauri::command]
pub fn pty_input(
    state: State<'_, AppState>,
    agent_id: String,
    data: String,
) -> Result<(), CommandError> {
    let mut reg = state
        .registry
        .lock()
        .map_err(|_| CommandError::Failed("state poisoned".into()))?;
    reg.write_input(&agent_id, data.as_bytes())
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    agent_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    let reg = state
        .registry
        .lock()
        .map_err(|_| CommandError::Failed("state poisoned".into()))?;
    reg.resize(&agent_id, cols, rows).map_err(CommandError::from)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, agent_id: String) -> Result<(), CommandError> {
    let mut reg = state
        .registry
        .lock()
        .map_err(|_| CommandError::Failed("state poisoned".into()))?;
    reg.kill(&agent_id);
    Ok(())
}

#[tauri::command]
pub fn pty_kill_all(state: State<'_, AppState>) -> Result<(), CommandError> {
    let mut reg = state
        .registry
        .lock()
        .map_err(|_| CommandError::Failed("state poisoned".into()))?;
    reg.clear();
    Ok(())
}

/// Show or hide the system-tray icon. Driven by the frontend "Hide to tray"
/// setting so the icon only appears for users who opt in.
#[tauri::command]
pub fn set_tray_visible(app: AppHandle, visible: bool) -> Result<(), CommandError> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_visible(visible)
            .map_err(|e| CommandError::Failed(e.to_string()))?;
    }
    Ok(())
}

/// Update the tray icon's hover tooltip (e.g. "Maestro · 3 running") so users
/// can see at a glance that agents are still alive while the window is hidden.
#[tauri::command]
pub fn set_tray_tooltip(app: AppHandle, tooltip: String) -> Result<(), CommandError> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_tooltip(Some(tooltip))
            .map_err(|e| CommandError::Failed(e.to_string()))?;
    }
    Ok(())
}
