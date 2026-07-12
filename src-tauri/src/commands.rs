use serde::Serialize;
use std::path::Path;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use crate::core::command_spec::CommandSpec;
use crate::error::{run_blocking, CommandError};
use crate::state::AppState;
use portable_pty::PtySize;

// All PTY commands are async: sync commands run on the main thread, and ConPTY
// creation (plus any wait on the registry lock while another agent is mid-
// spawn) is slow enough to visibly freeze the UI when a crew boots at once.

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
    code: u32,
}

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<Vec<(String, String)>>,
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
    spec.env = env.unwrap_or_default();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let app2 = app.clone();
    let exit_id = agent_id.clone();
    let registry = state.registry.clone();

    run_blocking(move || {
        let mut reg = registry
            .lock()
            .map_err(|_| CommandError::Failed("state poisoned".into()))?;
        reg.spawn(
            agent_id,
            &spec,
            size,
            move |bytes| {
                let _ = on_bytes.send(InvokeResponseBody::Raw(bytes.to_vec()));
            },
            move |code| {
                let _ = app2.emit("pty-exit", ExitPayload { id: exit_id, code });
            },
        )
        .map_err(CommandError::from)
    })
    .await
}

/// Re-attach a running agent's output stream to a NEW channel (used when a tab
/// is detached into another window: the PTY survives, only the consumer moves).
/// The agent's buffered scrollback is replayed through the channel first.
#[tauri::command]
pub async fn pty_attach(
    state: State<'_, AppState>,
    agent_id: String,
    on_bytes: Channel<InvokeResponseBody>,
) -> Result<(), CommandError> {
    let registry = state.registry.clone();
    run_blocking(move || {
        let reg = registry
            .lock()
            .map_err(|_| CommandError::Failed("state poisoned".into()))?;
        reg.attach(
            &agent_id,
            Box::new(move |bytes| {
                let _ = on_bytes.send(InvokeResponseBody::Raw(bytes.to_vec()));
            }),
        )
        .map_err(CommandError::from)
    })
    .await
}

#[tauri::command]
pub async fn pty_input(
    state: State<'_, AppState>,
    agent_id: String,
    data: String,
) -> Result<(), CommandError> {
    let registry = state.registry.clone();
    run_blocking(move || {
        let mut reg = registry
            .lock()
            .map_err(|_| CommandError::Failed("state poisoned".into()))?;
        reg.write_input(&agent_id, data.as_bytes())
            .map_err(CommandError::from)
    })
    .await
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, AppState>,
    agent_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    let registry = state.registry.clone();
    run_blocking(move || {
        let reg = registry
            .lock()
            .map_err(|_| CommandError::Failed("state poisoned".into()))?;
        reg.resize(&agent_id, cols, rows).map_err(CommandError::from)
    })
    .await
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, AppState>, agent_id: String) -> Result<(), CommandError> {
    let registry = state.registry.clone();
    run_blocking(move || {
        let mut reg = registry
            .lock()
            .map_err(|_| CommandError::Failed("state poisoned".into()))?;
        reg.kill(&agent_id);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn pty_kill_all(state: State<'_, AppState>) -> Result<(), CommandError> {
    let registry = state.registry.clone();
    run_blocking(move || {
        let mut reg = registry
            .lock()
            .map_err(|_| CommandError::Failed("state poisoned".into()))?;
        reg.clear();
        Ok(())
    })
    .await
}

/// Start recording an agent's terminal output to `path` (a JSONL "cast" file).
/// The frontend passes an absolute path under `<workspace>/.maestro/recordings`;
/// the parent directory is created if needed.
#[tauri::command]
pub async fn record_start(
    state: State<'_, AppState>,
    agent_id: String,
    path: String,
) -> Result<(), CommandError> {
    let registry = state.registry.clone();
    run_blocking(move || {
        if let Some(parent) = Path::new(&path).parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CommandError::Failed(format!("cannot create recordings dir: {e}")))?;
        }
        let reg = registry
            .lock()
            .map_err(|_| CommandError::Failed("state poisoned".into()))?;
        reg.record_start(&agent_id, &path)
            .map_err(CommandError::from)
    })
    .await
}

/// Stop recording an agent's output and flush its file.
#[tauri::command]
pub async fn record_stop(state: State<'_, AppState>, agent_id: String) -> Result<(), CommandError> {
    let registry = state.registry.clone();
    run_blocking(move || {
        let reg = registry
            .lock()
            .map_err(|_| CommandError::Failed("state poisoned".into()))?;
        reg.record_stop(&agent_id);
        Ok(())
    })
    .await
}

/// Read a recording file back for the replay player. Capped so a runaway
/// recording can't blow up memory; the player tolerates a truncated tail.
#[tauri::command]
pub async fn record_read(path: String) -> Result<String, CommandError> {
    const MAX_RECORDING_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB
    run_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| CommandError::Failed(e.to_string()))?;
        if meta.len() > MAX_RECORDING_BYTES {
            return Err(CommandError::Failed("recording too large to open (>64 MB)".into()));
        }
        std::fs::read_to_string(&path).map_err(|e| CommandError::Failed(e.to_string()))
    })
    .await
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

/// Resolve a single program name the way Windows' CreateProcess / cmd would and
/// report whether it's launchable. Absolute paths just check the file exists;
/// names ending in an executable extension (.exe/.com/…) are looked up verbatim
/// in each PATH directory; bare names are probed against every PATHEXT
/// extension in each PATH directory. Extension matching is case-insensitive.
fn program_on_path(program: &str, exts: &[String]) -> bool {
    let program = program.trim();
    if program.is_empty() {
        return false;
    }

    // Absolute (or otherwise rooted) path — just check the file is there.
    let p = Path::new(program);
    if p.is_absolute() || program.contains('/') || program.contains('\\') {
        return p.is_file();
    }

    // Does the name already carry one of the executable extensions? If so we
    // look it up verbatim rather than appending more extensions.
    let has_exe_ext = exts.iter().any(|ext| {
        let ext = ext.trim_start_matches('.');
        program.len() > ext.len()
            && program
                .get(program.len() - ext.len()..)
                .map(|tail| tail.eq_ignore_ascii_case(ext))
                .unwrap_or(false)
            && program.as_bytes()[program.len() - ext.len() - 1] == b'.'
    });

    let path_dirs: Vec<_> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();

    for dir in &path_dirs {
        if has_exe_ext {
            if dir.join(program).is_file() {
                return true;
            }
        } else {
            for ext in exts {
                // PATHEXT entries already include the leading dot (".EXE").
                if dir.join(format!("{program}{ext}")).is_file() {
                    return true;
                }
            }
        }
    }
    false
}

/// For each program name, report whether it resolves on PATH (see
/// `program_on_path`). Pure std — no per-item shelling out — so the wizard can
/// batch-check every preset's binary in one round-trip to gray out the ones
/// that aren't installed.
#[tauri::command]
pub async fn programs_on_path(programs: Vec<String>) -> Result<Vec<bool>, CommandError> {
    // PATH can contain slow/network dirs; probe off the main thread.
    run_blocking(move || programs_on_path_impl(programs)).await
}

fn programs_on_path_impl(programs: Vec<String>) -> Result<Vec<bool>, CommandError> {
    // PATHEXT decides which extensions a bare name can resolve to. Default to
    // the documented Windows set when it's unset, and uppercase-normalize for
    // tidy case-insensitive comparisons.
    let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let exts: Vec<String> = raw
        .split(';')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| {
            let s = if s.starts_with('.') {
                s.to_string()
            } else {
                format!(".{s}")
            };
            s.to_ascii_uppercase()
        })
        .collect();

    Ok(programs
        .iter()
        .map(|p| program_on_path(p, &exts))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_exts() -> Vec<String> {
        ".COM;.EXE;.BAT;.CMD"
            .split(';')
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn programs_finds_cmd_and_misses_fake() {
        let out = programs_on_path_impl(vec![
            "cmd.exe".into(),
            "cmd".into(),
            "definitely-not-a-real-cli-xyz".into(),
        ])
        .unwrap();
        assert_eq!(out.len(), 3);
        // cmd.exe (verbatim) and cmd (via PATHEXT) both live in System32.
        assert!(out[0], "cmd.exe should resolve on PATH");
        assert!(out[1], "cmd should resolve via PATHEXT");
        assert!(!out[2], "a bogus name must not resolve");
    }

    #[test]
    fn empty_name_is_not_found() {
        assert!(!program_on_path("", &default_exts()));
        assert!(!program_on_path("   ", &default_exts()));
    }

    #[test]
    fn absolute_path_checks_file_existence() {
        // A directory is not a file, and a bogus absolute path is absent.
        assert!(!program_on_path(
            "C:\\Windows\\System32\\no-such-binary.exe",
            &default_exts()
        ));
    }
}
