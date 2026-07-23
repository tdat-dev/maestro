use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum CommandError {
    #[error("{0}")]
    Failed(String),
    /// A write was rejected because the file changed on disk since it was read.
    /// Carries the current on-disk mtime (ms) so the UI can offer reload/overwrite.
    #[error("file changed on disk")]
    Conflict(i64),
}

impl From<anyhow::Error> for CommandError {
    fn from(e: anyhow::Error) -> Self {
        CommandError::Failed(e.to_string())
    }
}

/// Run blocking work (git, ConPTY spawns, PATH probing) on a dedicated
/// blocking thread. Sync `#[tauri::command]`s execute ON the main thread, so a
/// blocking body there freezes the whole window — no repaints, no input — for
/// its full duration (spawning several isolated agents froze the app for the
/// length of 3 full `git worktree add` checkouts). Commands wrap their body in
/// this instead and stay `async`.
pub async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| CommandError::Failed(format!("background task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_stable_shape() {
        let e = CommandError::Failed("boom".into());
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, r#"{"Failed":"boom"}"#);
    }
}
