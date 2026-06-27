from __future__ import annotations

import os
import subprocess


_SKIP = {".git", ".hg", ".svn"}


def _git(args: list[str], cwd: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, check=True,
                          capture_output=True, text=True)


def detect_mode(repo_path: str) -> str:
    if not os.path.isdir(repo_path):
        return "create"
    entries = [e for e in os.listdir(repo_path) if e not in _SKIP]
    return "edit" if entries else "create"


def _is_git_repo(path: str) -> bool:
    return os.path.isdir(os.path.join(path, ".git"))


def setup_worktree(repo_path: str, branch: str) -> str:
    os.makedirs(repo_path, exist_ok=True)
    mode = detect_mode(repo_path)

    if mode == "create" or not _is_git_repo(repo_path):
        if not _is_git_repo(repo_path):
            _git(["init"], repo_path)
        return repo_path

    parent = os.path.dirname(os.path.abspath(repo_path.rstrip("/\\")))
    wt_path = os.path.join(parent, f".orchestrator-wt-{branch.replace('/', '-')}")
    _git(["worktree", "add", "-b", branch, wt_path, "HEAD"], repo_path)
    return wt_path


def teardown_worktree(repo_path: str, worktree_path: str) -> None:
    if os.path.abspath(worktree_path) == os.path.abspath(repo_path):
        return
    try:
        _git(["worktree", "remove", "--force", worktree_path], repo_path)
    except subprocess.CalledProcessError:
        pass
