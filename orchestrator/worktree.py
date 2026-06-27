from __future__ import annotations

import os
import shutil
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

    if mode == "create":
        # Empty (or vcs-only) directory: init in place, return it directly.
        if not _is_git_repo(repo_path):
            _git(["init"], repo_path)
        return repo_path

    # edit mode: has source files
    if not _is_git_repo(repo_path):
        # Non-git source tree: snapshot it before creating a worktree so the
        # agent always works in isolation and never touches the raw files.
        _git(["init"], repo_path)
        _git(["add", "-A"], repo_path)
        # commit.gpgsign=false: never fail the snapshot if the user has global
        # signing enabled but no usable key in this environment.
        _git(["-c", "user.email=orchestrator@local", "-c", "user.name=orchestrator",
              "-c", "commit.gpgsign=false",
              "commit", "-m", "orchestrator: snapshot before agent run"], repo_path)

    parent = os.path.dirname(os.path.abspath(repo_path.rstrip("/\\")))
    wt_path = os.path.join(parent, f".orchestrator-wt-{branch.replace('/', '-')}")

    # Re-run safety: clear any stale worktree from a previous run.
    if os.path.exists(wt_path):
        teardown_worktree(repo_path, wt_path)
        # If git did not recognise it as a registered worktree (e.g. a leftover
        # plain directory), remove the bare path directly so the add below
        # cannot collide on an existing directory.
        if os.path.exists(wt_path):
            shutil.rmtree(wt_path, ignore_errors=True)
    # Drop stale worktree registrations (path already gone, metadata lingering).
    try:
        _git(["worktree", "prune"], repo_path)
    except subprocess.CalledProcessError:
        pass

    # -B force-creates or resets the branch (idempotent on re-run).
    _git(["worktree", "add", "-B", branch, wt_path, "HEAD"], repo_path)
    return wt_path


def teardown_worktree(repo_path: str, worktree_path: str) -> None:
    if os.path.abspath(worktree_path) == os.path.abspath(repo_path):
        return
    try:
        _git(["worktree", "remove", "--force", worktree_path], repo_path)
    except subprocess.CalledProcessError:
        pass
