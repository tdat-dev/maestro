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

/// Validate a target that may not exist yet (create / rename destination): its
/// parent must already exist inside `root`, and the final name must be a plain
/// component (no path separators, no `..`).
fn scoped_new(root: &str, path: &str) -> Result<PathBuf, CommandError> {
    let p = Path::new(path);
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| CommandError::Failed("invalid name".into()))?;
    if name == ".." || name.contains('/') || name.contains('\\') {
        return Err(CommandError::Failed("invalid name".into()));
    }
    let parent_rel = p.parent().map(|x| x.to_path_buf()).unwrap_or_default();
    let root_c = std::fs::canonicalize(root)
        .map_err(|e| CommandError::Failed(format!("bad root: {e}")))?;
    let parent_join = if parent_rel.as_os_str().is_empty() {
        root_c.clone()
    } else if parent_rel.is_absolute() {
        parent_rel.clone()
    } else {
        root_c.join(&parent_rel)
    };
    let parent_c = std::fs::canonicalize(&parent_join)
        .map_err(|e| CommandError::Failed(format!("no such folder: {e}")))?;
    if !parent_c.starts_with(&root_c) {
        return Err(CommandError::Failed("path escapes workspace root".into()));
    }
    Ok(parent_c.join(name))
}

/// Create a new empty file. Fails if a file already exists at the path.
#[tauri::command]
pub fn fs_create_file(root: String, path: String) -> Result<(), CommandError> {
    let target = scoped_new(&root, &path)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| CommandError::Failed(e.to_string()))?;
    Ok(())
}

/// Create a new directory. Fails if it already exists.
#[tauri::command]
pub fn fs_create_dir(root: String, path: String) -> Result<(), CommandError> {
    let target = scoped_new(&root, &path)?;
    std::fs::create_dir(&target).map_err(|e| CommandError::Failed(e.to_string()))?;
    Ok(())
}

/// Rename / move within the workspace. `from` must exist; `to`'s parent must
/// exist and stay inside the root.
#[tauri::command]
pub fn fs_rename(root: String, from: String, to: String) -> Result<(), CommandError> {
    let src = scoped(&root, &from)?;
    let dst = scoped_new(&root, &to)?;
    std::fs::rename(&src, &dst).map_err(|e| CommandError::Failed(e.to_string()))?;
    Ok(())
}

/// Delete a file, or a directory and all its contents.
#[tauri::command]
pub fn fs_delete(root: String, path: String) -> Result<(), CommandError> {
    let target = scoped(&root, &path)?;
    let meta = std::fs::symlink_metadata(&target).map_err(|e| CommandError::Failed(e.to_string()))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| CommandError::Failed(e.to_string()))?;
    } else {
        std::fs::remove_file(&target).map_err(|e| CommandError::Failed(e.to_string()))?;
    }
    Ok(())
}

/// Resolve a destination *folder* that must already exist inside `root`.
/// `""` means the root itself.
fn scoped_dir(root: &str, dir: &str) -> Result<PathBuf, CommandError> {
    let p = if dir.is_empty() {
        std::fs::canonicalize(root).map_err(|e| CommandError::Failed(format!("bad root: {e}")))?
    } else {
        scoped(root, dir)?
    };
    if !p.is_dir() {
        return Err(CommandError::Failed("not a folder".into()));
    }
    Ok(p)
}

/// Split a file name into (stem, extension-with-dot). `.gitignore` counts as a
/// stem with no extension, matching how explorers rename dotfiles.
fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// First free path in `dir` for `name`, appending ` copy`, ` copy 2`, … the way
/// Explorer/Finder do. Used by paste, duplicate and drag-copy so a collision
/// never silently overwrites the destination.
fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let direct = dir.join(name);
    if !direct.exists() {
        return direct;
    }
    let (stem, ext) = split_name(name);
    for n in 1..1000 {
        let candidate = if n == 1 {
            format!("{stem} copy{ext}")
        } else {
            format!("{stem} copy {n}{ext}")
        };
        let p = dir.join(&candidate);
        if !p.exists() {
            return p;
        }
    }
    direct
}

/// Recursively copy `src` (file or directory) to the exact path `dst`.
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for ent in std::fs::read_dir(src)? {
            let ent = ent?;
            copy_tree(&ent.path(), &dst.join(ent.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst).map(|_| ())
    }
}

/// Path of `p` relative to the canonical `root`, backslash-separated.
fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('/', "\\")
}

/// Copy an entry into `to_dir` (`""` = root), auto-renaming on collision.
/// Returns the new path, relative to the root.
#[tauri::command]
pub fn fs_copy(root: String, from: String, to_dir: String) -> Result<String, CommandError> {
    let src = scoped(&root, &from)?;
    let dir = scoped_dir(&root, &to_dir)?;
    if dir.starts_with(&src) {
        return Err(CommandError::Failed("cannot copy a folder into itself".into()));
    }
    let name = src
        .file_name()
        .ok_or_else(|| CommandError::Failed("invalid source".into()))?
        .to_string_lossy()
        .to_string();
    let dst = unique_in(&dir, &name);
    copy_tree(&src, &dst).map_err(|e| CommandError::Failed(e.to_string()))?;
    let root_c = std::fs::canonicalize(&root).map_err(|e| CommandError::Failed(e.to_string()))?;
    Ok(rel_of(&root_c, &dst))
}

/// Move an entry into `to_dir` (`""` = root), auto-renaming on collision.
/// Returns the new path, relative to the root. Falls back to copy+delete when
/// the rename crosses a volume boundary.
#[tauri::command]
pub fn fs_move(root: String, from: String, to_dir: String) -> Result<String, CommandError> {
    let src = scoped(&root, &from)?;
    let dir = scoped_dir(&root, &to_dir)?;
    if dir == src || dir.starts_with(&src) {
        return Err(CommandError::Failed("cannot move a folder into itself".into()));
    }
    let name = src
        .file_name()
        .ok_or_else(|| CommandError::Failed("invalid source".into()))?
        .to_string_lossy()
        .to_string();
    // Already there: nothing to do (dropping onto the current parent).
    if src.parent() == Some(dir.as_path()) {
        let root_c =
            std::fs::canonicalize(&root).map_err(|e| CommandError::Failed(e.to_string()))?;
        return Ok(rel_of(&root_c, &src));
    }
    let dst = unique_in(&dir, &name);
    if std::fs::rename(&src, &dst).is_err() {
        copy_tree(&src, &dst).map_err(|e| CommandError::Failed(e.to_string()))?;
        if src.is_dir() {
            std::fs::remove_dir_all(&src).map_err(|e| CommandError::Failed(e.to_string()))?;
        } else {
            std::fs::remove_file(&src).map_err(|e| CommandError::Failed(e.to_string()))?;
        }
    }
    let root_c = std::fs::canonicalize(&root).map_err(|e| CommandError::Failed(e.to_string()))?;
    Ok(rel_of(&root_c, &dst))
}

/// Send entries to the OS trash (Recycle Bin) in one operation, so a bulk delete
/// stays recoverable. Every path is validated against the root first; if the
/// platform has no trash, the caller is told and can fall back to `fs_delete`.
#[tauri::command]
pub fn fs_trash(root: String, paths: Vec<String>) -> Result<(), CommandError> {
    let mut targets = Vec::with_capacity(paths.len());
    for p in &paths {
        targets.push(scoped(&root, p)?);
    }
    if targets.is_empty() {
        return Ok(());
    }
    trash::delete_all(&targets).map_err(|e| CommandError::Failed(e.to_string()))
}

/// Open the OS file manager with the entry selected.
#[tauri::command]
pub fn fs_reveal(app: tauri::AppHandle, root: String, path: String) -> Result<(), CommandError> {
    use tauri_plugin_opener::OpenerExt;
    let target = scoped(&root, &path)?;
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|e| CommandError::Failed(e.to_string()))
}

/// Open an entry with the OS default application.
#[tauri::command]
pub fn fs_open_external(
    app: tauri::AppHandle,
    root: String,
    path: String,
) -> Result<(), CommandError> {
    use tauri_plugin_opener::OpenerExt;
    let target = scoped(&root, &path)?;
    app.opener()
        .open_path(target.to_string_lossy(), None::<&str>)
        .map_err(|e| CommandError::Failed(e.to_string()))
}

/// Refuse to inline images bigger than this as a data URL (base64 is +33%).
pub const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024; // 25 MiB

/// Image MIME for a path's extension, or None when it isn't a known image type.
fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Standard base64 (no line breaks). Small dependency-free encoder.
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Read an image file as a `data:<mime>;base64,...` URL for inline preview.
/// Rejects non-image extensions and oversize files.
#[tauri::command]
pub fn fs_read_data_url(root: String, path: String) -> Result<String, CommandError> {
    let file = scoped(&root, &path)?;
    let mime = image_mime(&file).ok_or_else(|| CommandError::Failed("not an image".into()))?;
    let meta = std::fs::metadata(&file).map_err(|e| CommandError::Failed(e.to_string()))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(CommandError::Failed("image too large to preview (>25 MB)".into()));
    }
    let bytes = std::fs::read(&file).map_err(|e| CommandError::Failed(e.to_string()))?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
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
    fn create_rename_delete_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        fs_create_dir(root.clone(), "src".into()).unwrap();
        assert!(tmp.path().join("src").is_dir());
        fs_create_file(root.clone(), "src\\a.txt".into()).unwrap();
        assert!(tmp.path().join("src").join("a.txt").is_file());
        fs_rename(root.clone(), "src\\a.txt".into(), "src\\b.txt".into()).unwrap();
        assert!(!tmp.path().join("src").join("a.txt").exists());
        assert!(tmp.path().join("src").join("b.txt").is_file());
        fs_delete(root.clone(), "src".into()).unwrap();
        assert!(!tmp.path().join("src").exists());
    }

    #[test]
    fn create_rejects_bad_name_and_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        assert!(fs_create_file(root.clone(), "..\\evil.txt".into()).is_err());
        assert!(fs_create_dir(root.clone(), "a\\..\\..\\b".into()).is_err());
    }

    #[test]
    fn copy_is_recursive_and_avoids_collisions() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        std::fs::create_dir_all(tmp.path().join("src").join("deep")).unwrap();
        std::fs::write(tmp.path().join("src").join("deep").join("a.txt"), "hi").unwrap();
        std::fs::create_dir(tmp.path().join("out")).unwrap();

        let rel = fs_copy(root.clone(), "src".into(), "out".into()).unwrap();
        assert_eq!(rel, "out\\src");
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("out").join("src").join("deep").join("a.txt"))
                .unwrap(),
            "hi"
        );
        // Copying again next to the original must not overwrite it.
        let again = fs_copy(root.clone(), "src".into(), "out".into()).unwrap();
        assert_eq!(again, "out\\src copy");
        // A folder can never be copied inside itself.
        assert!(fs_copy(root, "src".into(), "src\\deep".into()).is_err());
    }

    #[test]
    fn copy_file_suffixes_before_the_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        std::fs::write(tmp.path().join("a.txt"), "x").unwrap();
        let rel = fs_copy(root, "a.txt".into(), "".into()).unwrap();
        assert_eq!(rel, "a copy.txt");
    }

    #[test]
    fn move_relocates_and_avoids_collisions() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        std::fs::create_dir(tmp.path().join("a")).unwrap();
        std::fs::create_dir(tmp.path().join("b")).unwrap();
        std::fs::write(tmp.path().join("a").join("f.txt"), "1").unwrap();
        std::fs::write(tmp.path().join("b").join("f.txt"), "2").unwrap();

        let rel = fs_move(root.clone(), "a\\f.txt".into(), "b".into()).unwrap();
        assert_eq!(rel, "b\\f copy.txt");
        assert!(!tmp.path().join("a").join("f.txt").exists());
        // The pre-existing file at the destination is untouched.
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("b").join("f.txt")).unwrap(),
            "2"
        );
        // Dropping onto the folder it already lives in is a no-op, not a copy.
        let same = fs_move(root.clone(), "b\\f.txt".into(), "b".into()).unwrap();
        assert_eq!(same, "b\\f.txt");
        // A folder can never be moved into its own subtree.
        std::fs::create_dir(tmp.path().join("b").join("deep")).unwrap();
        assert!(fs_move(root, "b".into(), "b\\deep".into()).is_err());
    }

    #[test]
    fn trash_validates_every_path_before_deleting() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        std::fs::write(tmp.path().join("keep.txt"), "x").unwrap();
        let outside = tmp.path().parent().unwrap().join("outside-trash.txt");
        std::fs::write(&outside, "x").unwrap();
        let rel = format!("..\\{}", outside.file_name().unwrap().to_string_lossy());

        assert!(fs_trash(root, vec!["keep.txt".into(), rel]).is_err());
        // Nothing was removed: validation happens up-front, not per item.
        assert!(tmp.path().join("keep.txt").exists());
        assert!(outside.exists());
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn unique_in_walks_past_taken_copies() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "x").unwrap();
        std::fs::write(tmp.path().join("a copy.txt"), "x").unwrap();
        assert_eq!(
            unique_in(tmp.path(), "a.txt").file_name().unwrap(),
            "a copy 2.txt"
        );
        assert_eq!(unique_in(tmp.path(), "free.txt").file_name().unwrap(), "free.txt");
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
