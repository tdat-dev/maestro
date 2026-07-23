//! Filesystem watcher for the explorer. One recursive watch per workspace root;
//! raw notify events are coalesced into the set of *directories* that changed
//! and emitted as a single `fs-changed` event per debounce window, so a build
//! or an agent rewriting 200 files costs the UI one refresh, not 200.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{run_blocking, CommandError};
use crate::state::AppState;

/// Directory names whose churn the explorer never shows (mirrors HIDDEN_DIRS in
/// the frontend). Filtering here keeps `.git` index rewrites and `target/`
/// rebuilds from waking the UI thousands of times.
const NOISE_DIRS: &[&str] = &[".git", "node_modules", "target"];

/// How long to keep collecting after the first event before emitting.
const DEBOUNCE: Duration = Duration::from_millis(150);
/// Past this many distinct directories, tell the UI to refresh everything it has
/// open instead of shipping a huge list (a `git checkout` touches thousands).
const BULK_THRESHOLD: usize = 96;

#[derive(Clone, Serialize)]
struct ChangePayload {
    root: String,
    /// Relative directories (backslash-separated, `""` = the root itself).
    dirs: Vec<String>,
    /// True when the change set was too large to enumerate — refresh all.
    bulk: bool,
}

struct WatchHandle {
    root: PathBuf,
    stop: Arc<AtomicBool>,
    /// Held only to keep the watch alive; dropping it unsubscribes.
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
pub struct FsWatch {
    handle: Mutex<Option<WatchHandle>>,
}

/// Directory of `p` relative to `root`, or None when `p` sits outside the root
/// or inside a noise directory. Files map to their parent directory.
fn rel_dir(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    // A path event is about the entry itself; the *directory whose listing
    // changed* is its parent.
    let dir = rel.parent().unwrap_or_else(|| Path::new(""));
    let mut out = String::new();
    for comp in dir.components() {
        let s = comp.as_os_str().to_string_lossy();
        if NOISE_DIRS.contains(&s.as_ref()) {
            return None;
        }
        if !out.is_empty() {
            out.push('\\');
        }
        out.push_str(&s);
    }
    // The changed entry itself may be a noise dir (e.g. `target` being created).
    if let Some(name) = rel.file_name() {
        if NOISE_DIRS.contains(&name.to_string_lossy().as_ref()) {
            return None;
        }
    }
    Some(out)
}

/// Start watching `root`, replacing any previous watch. Emits `fs-changed`.
#[tauri::command]
pub async fn watch_start(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
) -> Result<(), CommandError> {
    let watch = state.watch.clone();
    run_blocking(move || {
        let root_c = std::fs::canonicalize(&root)
            .map_err(|e| CommandError::Failed(format!("bad root: {e}")))?;
        {
            // Already watching this exact folder — nothing to do.
            let cur = watch.handle.lock().unwrap();
            if cur.as_ref().is_some_and(|h| h.root == root_c) {
                return Ok(());
            }
        }
        let (tx, rx) = channel();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                let _ = tx.send(ev);
            }
        })
        .map_err(|e| CommandError::Failed(e.to_string()))?;
        watcher
            .watch(&root_c, RecursiveMode::Recursive)
            .map_err(|e| CommandError::Failed(e.to_string()))?;

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread_root = root_c.clone();
        // Echo back the caller's own root string, not the canonical one: on
        // Windows `canonicalize` yields a `\\?\` verbatim path, which would
        // never match the folder the frontend is showing.
        let emit_root = root.clone();
        std::thread::spawn(move || {
            'outer: loop {
                // Idle: wake periodically so a stopped watch can exit its thread.
                let first = loop {
                    if thread_stop.load(Ordering::Relaxed) {
                        break 'outer;
                    }
                    match rx.recv_timeout(Duration::from_millis(400)) {
                        Ok(ev) => break ev,
                        Err(RecvTimeoutError::Timeout) => continue,
                        Err(RecvTimeoutError::Disconnected) => break 'outer,
                    }
                };
                let mut dirs: HashSet<String> = HashSet::new();
                let soak = |ev: notify::Event, dirs: &mut HashSet<String>| {
                    for p in ev.paths {
                        if let Some(d) = rel_dir(&thread_root, &p) {
                            dirs.insert(d);
                        }
                    }
                };
                soak(first, &mut dirs);
                let deadline = Instant::now() + DEBOUNCE;
                while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                    match rx.recv_timeout(left) {
                        Ok(ev) => soak(ev, &mut dirs),
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => break 'outer,
                    }
                }
                if thread_stop.load(Ordering::Relaxed) {
                    break;
                }
                if dirs.is_empty() {
                    continue;
                }
                let bulk = dirs.len() > BULK_THRESHOLD;
                let payload = ChangePayload {
                    root: emit_root.clone(),
                    dirs: if bulk { Vec::new() } else { dirs.into_iter().collect() },
                    bulk,
                };
                let _ = app.emit("fs-changed", payload);
            }
        });

        let mut cur = watch.handle.lock().unwrap();
        if let Some(old) = cur.take() {
            old.stop.store(true, Ordering::Relaxed);
        }
        *cur = Some(WatchHandle {
            root: root_c,
            stop,
            _watcher: watcher,
        });
        Ok(())
    })
    .await
}

/// Stop the current watch (if any).
#[tauri::command]
pub async fn watch_stop(state: State<'_, AppState>) -> Result<(), CommandError> {
    let watch = state.watch.clone();
    run_blocking(move || {
        if let Some(old) = watch.handle.lock().unwrap().take() {
            old.stop.store(true, Ordering::Relaxed);
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_dir_maps_file_to_its_parent() {
        let root = Path::new("C:\\ws");
        assert_eq!(rel_dir(root, Path::new("C:\\ws\\a.txt")).unwrap(), "");
        assert_eq!(rel_dir(root, Path::new("C:\\ws\\src\\a.txt")).unwrap(), "src");
        assert_eq!(
            rel_dir(root, Path::new("C:\\ws\\src\\core\\a.rs")).unwrap(),
            "src\\core"
        );
    }

    #[test]
    fn rel_dir_filters_noise_and_outsiders() {
        let root = Path::new("C:\\ws");
        assert!(rel_dir(root, Path::new("C:\\ws\\.git\\index")).is_none());
        assert!(rel_dir(root, Path::new("C:\\ws\\src\\node_modules\\x\\p.js")).is_none());
        // The noise directory itself being created must not wake the UI either.
        assert!(rel_dir(root, Path::new("C:\\ws\\target")).is_none());
        assert!(rel_dir(root, Path::new("C:\\other\\a.txt")).is_none());
    }
}
