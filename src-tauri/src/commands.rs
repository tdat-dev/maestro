use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::core::command_spec::CommandSpec;
use crate::error::CommandError;
use crate::state::AppState;
use portable_pty::PtySize;

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    program: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    on_bytes: Channel<Vec<u8>>,
) -> Result<(), CommandError> {
    let mut spec = CommandSpec::new(program);
    for a in args {
        spec = spec.arg(a);
    }
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let channel = on_bytes.clone();
    let app2 = app.clone();

    let mut sup = state
        .supervisor
        .lock()
        .map_err(|_| CommandError::Failed("state poisoned".into()))?;
    sup.spawn(
        &spec,
        size,
        move |bytes| {
            let _ = channel.send(bytes.to_vec());
        },
        move |code| {
            let _ = app2.emit("pty-exit", code);
        },
    )
    .map_err(CommandError::from)
}

#[tauri::command]
pub fn pty_input(state: State<'_, AppState>, data: String) -> Result<(), CommandError> {
    let mut sup = state
        .supervisor
        .lock()
        .map_err(|_| CommandError::Failed("state poisoned".into()))?;
    sup.write_input(data.as_bytes()).map_err(CommandError::from)
}

#[tauri::command]
pub fn pty_resize(state: State<'_, AppState>, cols: u16, rows: u16) -> Result<(), CommandError> {
    let mut sup = state
        .supervisor
        .lock()
        .map_err(|_| CommandError::Failed("state poisoned".into()))?;
    sup.resize(cols, rows).map_err(CommandError::from)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>) -> Result<(), CommandError> {
    let mut sup = state
        .supervisor
        .lock()
        .map_err(|_| CommandError::Failed("state poisoned".into()))?;
    sup.kill().map_err(CommandError::from)
}
