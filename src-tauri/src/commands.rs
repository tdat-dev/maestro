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
    /// Which run of this agent id ended (see `pty_spawn`'s return value).
    run: u64,
}

/// Numbers every spawn. An agent restarted in place keeps its id; the run
/// tells its old process's late exit apart from the new one.
static NEXT_RUN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

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
) -> Result<u64, CommandError> {
    let mut spec = CommandSpec::new(program);
    for a in args {
        spec = spec.arg(a);
    }
    spec.cwd = cwd.filter(|s| !s.is_empty());
    // portable-pty falls back to the home folder when the cwd is missing, so an
    // agent would run somewhere nobody chose. Refuse and say which folder.
    if let Some(dir) = &spec.cwd {
        if !Path::new(dir).is_dir() {
            return Err(CommandError::Failed(format!("The folder {dir} doesn't exist anymore.")));
        }
    }
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
    let run = NEXT_RUN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

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
                let _ = app2.emit("pty-exit", ExitPayload { id: exit_id, code, run });
            },
        )
        .map_err(CommandError::from)?;
        Ok(run)
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

/// Token usage for one model, summed across a workspace's Claude transcripts.
#[derive(Serialize, Default, Clone)]
pub struct ModelUsage {
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation: u64,
    cache_read: u64,
    messages: u64,
}

/// Mangle a workspace path the way Claude Code names its transcript folder:
/// every non-alphanumeric character becomes '-'. e.g. `D:\maestro` -> `D--maestro`.
fn claude_project_slug(dir: &str) -> String {
    dir.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Sum Claude Code token usage for a workspace folder by reading the session
/// transcripts Claude writes under `~/.claude/projects/<slug>/*.jsonl`. These
/// are REAL usage numbers (not scraped from the terminal), but Claude-only and
/// per-workspace (a transcript folder isn't split by Maestro agent). Returns an
/// empty list when no transcripts exist for the folder.
#[tauri::command]
pub async fn claude_usage(dir: String) -> Result<Vec<ModelUsage>, CommandError> {
    run_blocking(move || Ok(claude_usage_impl(&dir))).await
}

fn claude_usage_impl(dir: &str) -> Vec<ModelUsage> {
    use std::collections::HashMap;
    let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(h) => h,
        Err(_) => return Vec::new(),
    };
    let proj = Path::new(&home)
        .join(".claude")
        .join("projects")
        .join(claude_project_slug(dir));
    let entries = match std::fs::read_dir(&proj) {
        Ok(e) => e,
        Err(_) => return Vec::new(), // no transcripts for this folder yet
    };
    let mut by_model: HashMap<String, ModelUsage> = HashMap::new();
    for ent in entries.flatten() {
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in content.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            let Some(usage) = v.get("message").and_then(|m| m.get("usage")) else {
                continue;
            };
            let model = v
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
                .unwrap_or("unknown")
                .to_string();
            let get = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            let e = by_model
                .entry(model.clone())
                .or_insert_with(|| ModelUsage { model, ..Default::default() });
            e.input_tokens += get("input_tokens");
            e.output_tokens += get("output_tokens");
            e.cache_creation += get("cache_creation_input_tokens");
            e.cache_read += get("cache_read_input_tokens");
            e.messages += 1;
        }
    }
    let mut out: Vec<ModelUsage> = by_model.into_values().collect();
    out.sort_by(|a, b| {
        (b.input_tokens + b.output_tokens).cmp(&(a.input_tokens + a.output_tokens))
    });
    out
}

/// New lines of one Claude Code transcript, for the chat view.
#[derive(Serialize, Default, Clone)]
pub struct TranscriptChunk {
    /// The file read, or "" when none was found yet.
    pub path: String,
    /// Complete JSONL lines from `offset` on (a half-written last line waits).
    pub text: String,
    /// Where to read from next time.
    pub next: u64,
}

/// Where pictures pasted into the chat composer are kept, and for how long.
const PASTE_DIR: &str = "maestro-paste";
const PASTE_KEEP_SECS: u64 = 7 * 24 * 3600;

/// Save a picture pasted into the chat composer (base64) as a file, so it can
/// reach the agent the way a dropped file does: as a path. Returns the path.
#[tauri::command]
pub async fn save_pasted_image(data: String, ext: String) -> Result<String, CommandError> {
    run_blocking(move || save_pasted_image_in(&std::env::temp_dir().join(PASTE_DIR), &data, &ext)).await
}

/// Most a file pasted into the chat may be (base64 grows it by a third on the way).
const PASTE_FILE_MAX: usize = 50 * 1024 * 1024;

/// Save a file pasted into the chat composer (copied in Explorer: the page gets
/// its content, not where it lives) under its own name, in a folder of its own
/// so two pastes of `notes.txt` don't collide. Returns the path.
#[tauri::command]
pub async fn save_pasted_file(data: String, name: String) -> Result<String, CommandError> {
    run_blocking(move || save_pasted_file_in(&std::env::temp_dir().join(PASTE_DIR), &data, &name)).await
}

fn save_pasted_file_in(dir: &Path, data: &str, name: &str) -> Result<String, CommandError> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    // Only the name: no folders, nothing Windows refuses in a file name.
    let clean: String = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let clean = clean.trim().trim_end_matches('.').to_string();
    let clean = if clean.is_empty() { "pasted".to_string() } else { clean };
    if data.len() / 4 * 3 > PASTE_FILE_MAX {
        return Err(CommandError::Failed(format!("{clean} is over {} MB", PASTE_FILE_MAX / 1024 / 1024)));
    }
    let bytes = STANDARD
        .decode(data.trim())
        .map_err(|e| CommandError::Failed(format!("bad file data: {e}")))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut folder = dir.join(format!("files-{stamp}"));
    let mut n = 1;
    while folder.exists() {
        folder = dir.join(format!("files-{stamp}-{n}"));
        n += 1;
    }
    std::fs::create_dir_all(&folder).map_err(|e| CommandError::Failed(e.to_string()))?;
    let path = folder.join(&clean);
    std::fs::write(&path, bytes).map_err(|e| CommandError::Failed(e.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

fn save_pasted_image_in(dir: &Path, data: &str, ext: &str) -> Result<String, CommandError> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return Err(CommandError::Failed(format!("not a picture type: {ext}")));
    }
    let bytes = STANDARD
        .decode(data.trim())
        .map_err(|e| CommandError::Failed(format!("bad picture data: {e}")))?;
    std::fs::create_dir_all(dir).map_err(|e| CommandError::Failed(e.to_string()))?;
    // Pastes from earlier sessions go after a week.
    if let Ok(list) = std::fs::read_dir(dir) {
        for entry in list.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > PASTE_KEEP_SECS);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut path = dir.join(format!("pasted-{stamp}.{ext}"));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("pasted-{stamp}-{n}.{ext}"));
        n += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| CommandError::Failed(e.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Most bytes one read hands back, so a long session loads in slices.
const TRANSCRIPT_SLICE: u64 = 2 * 1024 * 1024;

/// Read an agent's transcript under `~/.claude/projects/<slug of dir>/`: the
/// `<session_id>.jsonl` Maestro started it with, or, when that is unknown, the
/// newest transcript written since `since_ms` (an agent started by hand).
/// Returns the complete lines after `offset`.
#[tauri::command]
pub async fn claude_transcript(
    dir: String,
    session_id: Option<String>,
    since_ms: Option<u64>,
    offset: u64,
) -> Result<TranscriptChunk, CommandError> {
    run_blocking(move || Ok(claude_transcript_impl(&dir, session_id.as_deref(), since_ms, offset))).await
}

fn claude_transcript_impl(dir: &str, session_id: Option<&str>, since_ms: Option<u64>, offset: u64) -> TranscriptChunk {
    use std::io::{Read, Seek, SeekFrom};
    let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(h) => h,
        Err(_) => return TranscriptChunk::default(),
    };
    let proj = Path::new(&home).join(".claude").join("projects").join(claude_project_slug(dir));
    let path = match session_id {
        // A session id is a UUID; anything else never reaches the filesystem.
        Some(id) if !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') => {
            proj.join(format!("{id}.jsonl"))
        }
        _ => {
            let since = since_ms.unwrap_or(0);
            let Ok(entries) = std::fs::read_dir(&proj) else {
                return TranscriptChunk::default();
            };
            let mut best: Option<(u128, std::path::PathBuf)> = None;
            for ent in entries.flatten() {
                let p = ent.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let Ok(meta) = ent.metadata() else { continue };
                let Ok(modified) = meta.modified() else { continue };
                let ms = modified
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                if ms < since as u128 {
                    continue;
                }
                if best.as_ref().map_or(true, |(b, _)| ms > *b) {
                    best = Some((ms, p));
                }
            }
            match best {
                Some((_, p)) => p,
                None => return TranscriptChunk::default(),
            }
        }
    };
    let Ok(mut file) = std::fs::File::open(&path) else {
        return TranscriptChunk { path: String::new(), text: String::new(), next: offset };
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    // The file was replaced or cut: start over.
    let start = if offset > size { 0 } else { offset };
    let want = (size - start).min(TRANSCRIPT_SLICE);
    let mut buf = vec![0u8; want as usize];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
        return TranscriptChunk { path: path.to_string_lossy().into_owned(), text: String::new(), next: start };
    }
    // Hand back whole lines only; the rest is read next time.
    let cut = match buf.iter().rposition(|&b| b == b'\n') {
        Some(i) => i + 1,
        None => 0,
    };
    buf.truncate(cut);
    TranscriptChunk {
        path: path.to_string_lossy().into_owned(),
        text: String::from_utf8_lossy(&buf).into_owned(),
        next: start + cut as u64,
    }
}

/// Where Claude Code keeps the transcripts of sessions run in `dir`.
pub(crate) fn claude_project_dir(dir: &str) -> Option<std::path::PathBuf> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    Some(Path::new(&home).join(".claude").join("projects").join(claude_project_slug(dir)))
}

/// A session id is a UUID; anything else never reaches the filesystem.
fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Whether Claude Code has a transcript for this session in `dir`, i.e.
/// whether `claude --resume <id>` can pick it up.
#[tauri::command]
pub async fn claude_session_exists(dir: String, session_id: String) -> Result<bool, CommandError> {
    run_blocking(move || {
        Ok(is_session_id(&session_id)
            && claude_project_dir(&dir).map_or(false, |p| p.join(format!("{session_id}.jsonl")).is_file()))
    })
    .await
}

/// One earlier conversation, for "resume a conversation".
#[derive(Serialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub modified_ms: u64,
    /// Claude's own title for it, else your first message.
    pub title: String,
    pub messages: u32,
    /// The folder it ran in: `claude --resume` only picks it up from there.
    pub cwd: String,
}

/// The conversations Claude Code has in `dir`, newest first. Sessions with
/// nothing you typed (a local /cost, a /model) are left out. Only the start of
/// each file is read: the title and the first message are near the top.
#[tauri::command]
pub async fn claude_sessions(dir: String) -> Result<Vec<SessionInfo>, CommandError> {
    run_blocking(move || Ok(claude_sessions_impl(&dir))).await
}

/// The newest conversations in every folder, so one begun elsewhere can be
/// carried on (in its own folder).
#[tauri::command]
pub async fn claude_sessions_everywhere(limit: usize) -> Result<Vec<SessionInfo>, CommandError> {
    run_blocking(move || Ok(claude_sessions_everywhere_impl(limit.clamp(1, 200)))).await
}

fn claude_sessions_impl(dir: &str) -> Vec<SessionInfo> {
    let Some(proj) = claude_project_dir(dir) else { return Vec::new() };
    let mut out: Vec<SessionInfo> = session_files(&proj).into_iter().filter_map(|(path, ms)| session_info(&path, ms)).collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out.truncate(40);
    out
}

fn claude_sessions_everywhere_impl(limit: usize) -> Vec<SessionInfo> {
    let Some(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok() else { return Vec::new() };
    let root = Path::new(&home).join(".claude").join("projects");
    let Ok(projects) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut files: Vec<(std::path::PathBuf, u64)> = projects.flatten().filter(|p| p.path().is_dir()).flat_map(|p| session_files(&p.path())).collect();
    // Only the newest files are opened: a few extra for the ones with nothing typed.
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.truncate(limit * 2);
    let mut out: Vec<SessionInfo> = files.into_iter().filter_map(|(path, ms)| session_info(&path, ms)).collect();
    out.truncate(limit);
    out
}

/// The session transcripts in one project folder, with when each last changed.
fn session_files(proj: &Path) -> Vec<(std::path::PathBuf, u64)> {
    let Ok(entries) = std::fs::read_dir(proj) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|ent| {
            let path = ent.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                return None;
            }
            let id = path.file_stem().and_then(|s| s.to_str())?;
            if !is_session_id(id) {
                return None;
            }
            let ms = ent
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Some((path, ms))
        })
        .collect()
}

/// What the start of a transcript says: its title, how many messages you
/// typed, the folder it ran in. None when you typed nothing.
fn session_info(path: &Path, modified_ms: u64) -> Option<SessionInfo> {
    use std::io::Read;
    let id = path.file_stem().and_then(|s| s.to_str())?.to_string();
    let file = std::fs::File::open(path).ok()?;
    let mut head = Vec::new();
    let _ = file.take(768 * 1024).read_to_end(&mut head);
    let text = String::from_utf8_lossy(&head);
    let mut title: Option<String> = None;
    let mut first: Option<String> = None;
    let mut cwd = String::new();
    let mut messages = 0u32;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                cwd = c.to_string();
            }
        }
        match v.get("type").and_then(|t| t.as_str()) {
            Some("ai-title") => {
                if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                    title = Some(t.to_string());
                }
            }
            Some("user") => {
                if v.get("isMeta").and_then(|x| x.as_bool()) == Some(true) {
                    continue;
                }
                let human = v.get("origin").and_then(|o| o.get("kind")).and_then(|k| k.as_str()).map_or(true, |k| k == "human");
                let content = v.get("message").and_then(|m| m.get("content"));
                let said = match content {
                    Some(serde_json::Value::String(s)) => Some(s.clone()),
                    Some(serde_json::Value::Array(parts)) => parts
                        .iter()
                        .find(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
                        .and_then(|p| p.get("text").and_then(|t| t.as_str()).map(str::to_string)),
                    _ => None,
                };
                let Some(said) = said else { continue };
                if !human || said.starts_with('<') || said.starts_with("[Request interrupted") {
                    continue; // commands, their output, caveats, tool results
                }
                messages += 1;
                if first.is_none() {
                    first = Some(said.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(90).collect());
                }
            }
            _ => {}
        }
    }
    if messages == 0 {
        return None;
    }
    Some(SessionInfo { id, modified_ms, title: title.or(first).unwrap_or_default(), messages, cwd })
}

/// Most output `run_capture` keeps: a CLI that prints more is cut here.
const CAPTURE_MAX: usize = 8 * 1024 * 1024;

/// Run a program to completion (no window, no stdin) in `cwd` and return its
/// stdout. For asking an agent CLI about itself, e.g. Claude Code's
/// `claude -p /cost --output-format stream-json --verbose`, whose first
/// event lists its commands, skills and model without calling the model.
/// Killed (with its child processes) after `timeout_ms`.
#[tauri::command]
pub async fn run_capture(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<String, CommandError> {
    run_blocking(move || run_capture_impl(&program, &args, cwd.as_deref(), timeout_ms.unwrap_or(60_000))).await
}

fn run_capture_impl(program: &str, args: &[String], cwd: Option<&str>, timeout_ms: u64) -> Result<String, CommandError> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        if !Path::new(dir).is_dir() {
            return Err(CommandError::Failed(format!("The folder {dir} doesn't exist anymore.")));
        }
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| CommandError::Failed(format!("couldn't start {program}: {e}")))?;
    let pid = child.id();
    let mut out = child.stdout.take().ok_or_else(|| CommandError::Failed("no stdout".into()))?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match out.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if buf.len() < CAPTURE_MAX {
                        buf.extend_from_slice(&chunk[..n.min(CAPTURE_MAX - buf.len())]);
                    }
                }
            }
        }
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(std::time::Duration::from_millis(timeout_ms)) {
        Ok(buf) => {
            let _ = child.wait();
            Ok(String::from_utf8_lossy(&buf).into_owned())
        }
        Err(_) => {
            // Take the whole tree down: a .cmd shim leaves its node process behind.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .creation_flags(0x0800_0000)
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
            Err(CommandError::Failed(format!("{program} took longer than {} s", timeout_ms / 1000)))
        }
    }
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
    fn claude_slug_matches_observed_folder() {
        // Verified against the real folder Claude Code created for D:\maestro.
        assert_eq!(claude_project_slug("D:\\maestro"), "D--maestro");
        assert_eq!(claude_project_slug("C:\\Users\\a\\proj"), "C--Users-a-proj");
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

#[cfg(test)]
mod paste_tests {
    use super::*;

    #[test]
    fn a_pasted_picture_is_saved_as_its_own_file() {
        let dir = std::env::temp_dir().join(format!("maestro-paste-test-{}", std::process::id()));
        let a = save_pasted_image_in(&dir, "iVBORw0KGgo=", "PNG").unwrap();
        let b = save_pasted_image_in(&dir, "iVBORw0KGgo=", ".png").unwrap();
        assert_ne!(a, b);
        assert!(a.ends_with(".png"));
        assert_eq!(std::fs::read(&a).unwrap(), b"\x89PNG\r\n\x1a\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pasted_file_keeps_its_name_in_a_folder_of_its_own() {
        let dir = std::env::temp_dir().join(format!("maestro-paste-test3-{}", std::process::id()));
        let a = save_pasted_file_in(&dir, "aGk=", "notes.txt").unwrap();
        let b = save_pasted_file_in(&dir, "aGk=", "notes.txt").unwrap();
        assert!(a.ends_with("notes.txt") && b.ends_with("notes.txt"));
        assert_ne!(a, b);
        assert_eq!(std::fs::read(&a).unwrap(), b"hi");
        // a name can't climb out of the folder or carry what Windows refuses
        let c = save_pasted_file_in(&dir, "aGk=", "..\\..\\evil:name?.txt").unwrap();
        assert!(Path::new(&c).starts_with(&dir));
        assert!(c.ends_with("evil_name_.txt"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_pictures_and_real_base64_are_saved() {
        let dir = std::env::temp_dir().join(format!("maestro-paste-test2-{}", std::process::id()));
        assert!(save_pasted_image_in(&dir, "iVBORw0KGgo=", "exe").is_err());
        assert!(save_pasted_image_in(&dir, "not base64!", "png").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn a_session_says_its_folder_title_and_what_you_typed() {
        let dir = std::env::temp_dir().join(format!("maestro-sessions-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = "11111111-2222-3333-4444-555555555555";
        let lines = [
            r#"{"type":"user","cwd":"D:\\zoldify","origin":{"kind":"human"},"message":{"content":"fix   the build"}}"#,
            r#"{"type":"user","cwd":"D:\\zoldify","origin":{"kind":"task-notification"},"message":{"content":"done"}}"#,
            r#"{"type":"ai-title","aiTitle":"Fix the build"}"#,
        ];
        let path = dir.join(format!("{id}.jsonl"));
        std::fs::write(&path, lines.join("\n")).unwrap();
        let s = session_info(&path, 7).unwrap();
        assert_eq!((s.id.as_str(), s.title.as_str(), s.messages, s.cwd.as_str(), s.modified_ms), (id, "Fix the build", 1, "D:\\zoldify", 7));
        // nothing typed: not a conversation to resume
        let empty = dir.join("22222222-2222-3333-4444-555555555555.jsonl");
        std::fs::write(&empty, r#"{"type":"user","origin":{"kind":"task-notification"},"message":{"content":"x"}}"#).unwrap();
        assert!(session_info(&empty, 1).is_none());
        assert_eq!(session_files(&dir).len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
