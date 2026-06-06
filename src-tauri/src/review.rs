use crate::error::CommandError;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

fn git(args: &[&str], cwd: &str) -> Result<String, CommandError> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| CommandError::Failed(format!("git not available: {e}")))?;
    if !out.status.success() {
        return Err(CommandError::Failed(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[derive(Serialize)]
pub struct RepoRef {
    pub path: String,
    pub name: String,
}

/// Discover the git repos to review under `dir`:
/// - if `dir` itself is a git repo → return just it;
/// - else → each immediate sub-folder that is a git repo (parent-of-repos case);
/// - else → empty.
#[tauri::command]
pub fn git_repos_under(dir: String) -> Vec<RepoRef> {
    let mk = |p: &Path| RepoRef {
        path: p.to_string_lossy().replace('/', "\\"),
        name: p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
    };
    // Case 1: dir itself is a repo.
    if git(&["rev-parse", "--is-inside-work-tree"], &dir)
        .map(|s| s == "true")
        .unwrap_or(false)
    {
        if let Ok(top) = git(&["rev-parse", "--show-toplevel"], &dir) {
            return vec![mk(Path::new(&top))];
        }
    }
    // Case 2: immediate sub-folders that are repos.
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        paths.sort();
        for p in paths {
            if p.is_dir() && p.join(".git").exists() {
                out.push(mk(&p));
            }
        }
    }
    out
}

/// Raw unified diff of a repo's working tree vs HEAD (staged + unstaged),
/// including untracked files. Empty string when the tree is clean.
#[tauri::command]
pub fn repo_diff(repo_root: String) -> Result<String, CommandError> {
    // `--no-color`, 3 lines of context; `HEAD` covers staged+unstaged tracked
    // changes. Untracked files are appended via a second pass below.
    let tracked = git(
        &["-c", "core.quotepath=false", "diff", "--no-color", "HEAD"],
        &repo_root,
    )
    .unwrap_or_default();
    Ok(tracked)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo(dir: &Path) {
        let d = dir.to_str().unwrap();
        git(&["init", "-q"], d).unwrap();
        git(&["config", "user.email", "t@t.dev"], d).unwrap();
        git(&["config", "user.name", "t"], d).unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&["add", "-A"], d).unwrap();
        git(&["commit", "-qm", "init"], d).unwrap();
    }

    #[test]
    fn finds_single_repo_when_dir_is_a_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("solo");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
        let got = git_repos_under(repo.to_string_lossy().to_string());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "solo");
    }

    #[test]
    fn finds_sub_repos_under_a_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("parent");
        std::fs::create_dir(&parent).unwrap();
        for name in ["repoA", "repoB"] {
            let r = parent.join(name);
            std::fs::create_dir(&r).unwrap();
            init_repo(&r);
        }
        std::fs::create_dir(parent.join("plain")).unwrap(); // non-git, ignored
        let got = git_repos_under(parent.to_string_lossy().to_string());
        let names: Vec<_> = got.iter().map(|r| r.name.clone()).collect();
        assert_eq!(names, vec!["repoA".to_string(), "repoB".to_string()]);
    }

    #[test]
    fn repo_diff_shows_working_tree_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("r");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap(); // modify tracked file
        let d = repo_diff(repo.to_string_lossy().to_string()).unwrap();
        assert!(d.contains("a.txt"), "diff should name the file: {d}");
        assert!(d.contains("+two"), "diff should show the added line: {d}");
    }

    #[test]
    fn repo_diff_clean_tree_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("clean");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
        assert_eq!(repo_diff(repo.to_string_lossy().to_string()).unwrap(), "");
    }
}
