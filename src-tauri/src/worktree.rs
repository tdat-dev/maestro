use std::path::{Path, PathBuf};

use crate::error::CommandError;
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW — the release build is a windowed subsystem app with no
/// console, so a child `git` spawned without this flag pops up a flashing
/// console window (which steals focus and looks like a UI freeze).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A short, stable, filesystem-safe slug for an arbitrary string.
fn slug(s: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// djb2 hash → 6-char base36, so two repos with the same folder name don't collide.
fn short_hash(s: &str) -> String {
    let mut h: u64 = 5381;
    for b in s.bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as u64);
    }
    let mut n = h;
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut buf = [b'0'; 6];
    for i in (0..6).rev() {
        buf[i] = digits[(n % 36) as usize];
        n /= 36;
    }
    String::from_utf8(buf.to_vec()).unwrap()
}

/// Validate that a branch name is safe to pass to git and the filesystem.
fn valid_branch(b: &str) -> bool {
    !b.is_empty()
        && !b.starts_with('-')
        && !b.contains("..")
        && b.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'/' | b'-' | b'_' | b'.'))
}

/// Compute the worktree directory for a repo + branch:
/// `<drive>:\.maestro-worktrees\<repo-slug>-<hash>\<branch-slug>-<branch-hash>`.
/// The root sits on the repo's own drive (never C:/profile) and out of the repo tree.
/// NOTE: UNC paths (\\server\share) are unsupported — Windows-local repos only.
pub fn worktree_path_for(repo_root: &str, branch: &str) -> PathBuf {
    let root = Path::new(repo_root);
    let repo_name = root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".into());
    // Drive prefix on Windows (e.g. "D:"); fall back to the path root otherwise.
    let drive = repo_root.get(0..2).filter(|d| d.ends_with(':')).unwrap_or("");
    let folder = format!("{}-{}", slug(&repo_name), short_hash(repo_root));
    let leaf = format!("{}-{}", slug(branch), short_hash(branch));
    let mut p = PathBuf::new();
    p.push(format!("{}\\", drive));
    p.push(".maestro-worktrees");
    p.push(folder);
    p.push(leaf);
    p
}

fn git(args: &[&str], cwd: &str) -> Result<String, CommandError> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .output()
        .map_err(|e| CommandError::Failed(format!("git not available: {e}")))?;
    if !out.status.success() {
        return Err(CommandError::Failed(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Return the repo root if `dir` is inside a single git repo, else `None`
/// (a non-git folder, or a parent that merely *contains* repos).
#[tauri::command]
pub fn git_repo_root(dir: String) -> Option<String> {
    git(&["rev-parse", "--show-toplevel"], &dir)
        .ok()
        .map(|p| p.replace('/', "\\"))
}

/// Create a worktree on a new branch off HEAD. Returns the worktree path.
#[tauri::command]
pub fn worktree_add(repo_root: String, branch: String) -> Result<String, CommandError> {
    if !valid_branch(&branch) {
        return Err(CommandError::Failed(format!("invalid branch name: {branch}")));
    }
    let path = worktree_path_for(&repo_root, &branch);
    let path_str = path.to_string_lossy().to_string();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CommandError::Failed(format!("mkdir worktree root: {e}")))?;
    }
    git(
        &["worktree", "add", "-b", &branch, &path_str, "HEAD"],
        &repo_root,
    )?;
    Ok(path_str)
}

/// Remove a worktree (and optionally delete its branch).
#[tauri::command]
pub fn worktree_remove(
    repo_root: String,
    path: String,
    branch: Option<String>,
) -> Result<(), CommandError> {
    git(&["worktree", "remove", "--force", &path], &repo_root)?;
    if let Some(b) = branch {
        let _ = git(&["branch", "-D", &b], &repo_root); // best-effort
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_lives_on_repo_drive_under_hidden_root() {
        let p = worktree_path_for("D:\\WhaleloSource\\payments-svc", "maestro/claude-a1b2")
            .to_string_lossy()
            .to_string();
        assert!(p.starts_with("D:\\.maestro-worktrees\\"), "got {p}");
        assert!(p.contains("payments-svc-"), "got {p}");
        assert!(p.contains("maestro-claude-a1b2-"), "got {p}");
    }

    #[test]
    fn same_name_different_path_differ() {
        let a = worktree_path_for("D:\\a\\app", "maestro/x");
        let b = worktree_path_for("D:\\b\\app", "maestro/x");
        assert_ne!(a, b);
    }

    #[test]
    fn worktree_add_rejects_bad_branch() {
        let result = worktree_add("D:\\whatever".into(), "../evil".into());
        assert!(result.is_err(), "expected Err for bad branch name, got Ok");
    }

    fn init_repo(dir: &std::path::Path) {
        let d = dir.to_str().unwrap();
        git(&["init", "-q"], d).unwrap();
        git(&["config", "user.email", "t@t.dev"], d).unwrap();
        git(&["config", "user.name", "t"], d).unwrap();
        std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
        git(&["add", "-A"], d).unwrap();
        git(&["commit", "-qm", "init"], d).unwrap();
    }

    #[test]
    fn repo_root_detects_git_and_rejects_plain() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("proj");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
        let got = git_repo_root(repo.to_string_lossy().to_string());
        assert!(got.is_some());

        let plain = tmp.path().join("plain");
        std::fs::create_dir(&plain).unwrap();
        assert!(git_repo_root(plain.to_string_lossy().to_string()).is_none());
    }

    #[test]
    fn worktree_add_then_remove_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("proj");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
        let root = repo.to_string_lossy().to_string();

        // Note: worktree_path_for puts the tree on the repo's drive; for the test we
        // verify the branch+worktree are created and listed, then removed.
        let wt = worktree_add(root.clone(), "maestro/test-1".into()).expect("add");
        assert!(std::path::Path::new(&wt).join("a.txt").exists());
        let list = git(&["worktree", "list"], &root).unwrap();
        assert!(list.contains("maestro/test-1") || list.contains(&wt));

        worktree_remove(root.clone(), wt.clone(), Some("maestro/test-1".into())).expect("remove");
        assert!(!std::path::Path::new(&wt).exists());
    }
}
