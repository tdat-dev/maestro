use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::CommandError;

/// Refuse to open files larger than this (binary blobs, build artifacts, etc.).
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize)]
pub struct FileData {
    pub content: String,
    pub mtime: i64,
}

#[derive(Serialize)]
pub struct Stat {
    pub mtime: i64,
}

#[derive(Serialize, Debug)]
pub struct WriteResult {
    pub mtime: i64,
}

/// Modified-time in milliseconds since the Unix epoch (0 when unavailable).
pub fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Canonicalize `path` (absolute, or relative to `root`) and verify it stays
/// inside the canonical `root`. Rejects `..` escapes, absolute paths outside
/// the workspace, and symlinks that resolve outside. The target must exist.
pub fn scoped(root: &str, path: &str) -> Result<PathBuf, CommandError> {
    let root_c = std::fs::canonicalize(root)
        .map_err(|e| CommandError::Failed(format!("bad root: {e}")))?;
    let target = Path::new(path);
    let joined: PathBuf = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root_c.join(target)
    };
    let canon = std::fs::canonicalize(&joined)
        .map_err(|e| CommandError::Failed(format!("no such path: {e}")))?;
    if !canon.starts_with(&root_c) {
        return Err(CommandError::Failed("path escapes workspace root".into()));
    }
    Ok(canon)
}

/// List one directory level. Directories first, then case-insensitive by name.
#[tauri::command]
pub fn fs_read_dir(root: String, path: String) -> Result<Vec<Entry>, CommandError> {
    let dir = scoped(&root, &path)?;
    let mut out = Vec::new();
    for ent in std::fs::read_dir(&dir).map_err(|e| CommandError::Failed(e.to_string()))? {
        let ent = ent.map_err(|e| CommandError::Failed(e.to_string()))?;
        let meta = ent
            .metadata()
            .map_err(|e| CommandError::Failed(e.to_string()))?;
        out.push(Entry {
            name: ent.file_name().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Read a UTF-8 (lossy) text file. Refuses oversize or binary files.
#[tauri::command]
pub fn fs_read_file(root: String, path: String) -> Result<FileData, CommandError> {
    let file = scoped(&root, &path)?;
    let meta = std::fs::metadata(&file).map_err(|e| CommandError::Failed(e.to_string()))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(CommandError::Failed("file too large to open (>2 MB)".into()));
    }
    let bytes = std::fs::read(&file).map_err(|e| CommandError::Failed(e.to_string()))?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err(CommandError::Failed("binary file".into()));
    }
    Ok(FileData {
        content: String::from_utf8_lossy(&bytes).to_string(),
        mtime: mtime_ms(&meta),
    })
}

/// Cheap modified-time probe for external-change detection.
#[tauri::command]
pub fn fs_stat(root: String, path: String) -> Result<Stat, CommandError> {
    let file = scoped(&root, &path)?;
    let meta = std::fs::metadata(&file).map_err(|e| CommandError::Failed(e.to_string()))?;
    Ok(Stat {
        mtime: mtime_ms(&meta),
    })
}

/// Write a text file. When `expected_mtime` is provided and the on-disk mtime
/// differs, the write is refused with `Conflict(current_mtime)` so the caller
/// never silently clobbers an external (agent) edit. Returns the new mtime.
#[tauri::command]
pub fn fs_write_file(
    root: String,
    path: String,
    content: String,
    expected_mtime: Option<i64>,
) -> Result<WriteResult, CommandError> {
    let file = scoped(&root, &path)?;
    if let Some(expected) = expected_mtime {
        let meta = std::fs::metadata(&file).map_err(|e| CommandError::Failed(e.to_string()))?;
        let current = mtime_ms(&meta);
        if current != expected {
            return Err(CommandError::Conflict(current));
        }
    }
    std::fs::write(&file, content.as_bytes()).map_err(|e| CommandError::Failed(e.to_string()))?;
    let meta = std::fs::metadata(&file).map_err(|e| CommandError::Failed(e.to_string()))?;
    Ok(WriteResult {
        mtime: mtime_ms(&meta),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_rejects_parent_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        // A sibling outside root.
        let outside = tmp.path().parent().unwrap().join("outside.txt");
        std::fs::write(&outside, "x").unwrap();
        let rel = format!("..\\{}", outside.file_name().unwrap().to_string_lossy());
        assert!(scoped(&root, &rel).is_err());
    }

    #[test]
    fn scoped_accepts_nested_child() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("sub")).unwrap();
        std::fs::write(tmp.path().join("sub").join("a.txt"), "hi").unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        assert!(scoped(&root, "sub\\a.txt").is_ok());
    }

    #[test]
    fn read_dir_lists_dirs_first_sorted() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("b.txt"), "x").unwrap();
        std::fs::write(tmp.path().join("A.txt"), "x").unwrap();
        std::fs::create_dir(tmp.path().join("zdir")).unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let got = fs_read_dir(root, ".".into()).unwrap();
        let names: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["zdir", "A.txt", "b.txt"]);
        assert!(got[0].is_dir);
    }

    #[test]
    fn read_file_returns_content_and_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let f = fs_read_file(root, "a.txt".into()).unwrap();
        assert_eq!(f.content, "hello");
        assert!(f.mtime > 0);
    }

    #[test]
    fn read_file_rejects_binary() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("b.bin"), [0u8, 1, 2, 3]).unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        assert!(fs_read_file(root, "b.bin".into()).is_err());
    }

    #[test]
    fn write_file_persists_and_returns_new_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "old").unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let r = fs_write_file(root.clone(), "a.txt".into(), "new".into(), None).unwrap();
        assert!(r.mtime > 0);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn write_file_conflicts_on_stale_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "old").unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        // Pretend we read it at mtime 1 (definitely stale vs. the real file).
        let err = fs_write_file(root, "a.txt".into(), "new".into(), Some(1)).unwrap_err();
        match err {
            CommandError::Conflict(_) => {}
            other => panic!("expected Conflict, got {other:?}"),
        }
        // File must be untouched.
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "old"
        );
    }
}
