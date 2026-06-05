use serde::Serialize;
use tauri::ipc::Channel;
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
    on_bytes: Channel<Vec<u8>>,
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
            let _ = channel.send(bytes.to_vec());
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
