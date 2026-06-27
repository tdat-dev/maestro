import os
import subprocess

from orchestrator.worktree import detect_mode, setup_worktree, teardown_worktree


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True,
                   capture_output=True, text=True)


def test_detect_mode_empty_is_create(tmp_path):
    assert detect_mode(str(tmp_path)) == "create"


def test_detect_mode_with_source_is_edit(tmp_path):
    (tmp_path / "main.py").write_text("print(1)", encoding="utf-8")
    assert detect_mode(str(tmp_path)) == "edit"


def test_detect_mode_only_dotgit_is_create(tmp_path):
    os.makedirs(tmp_path / ".git")
    assert detect_mode(str(tmp_path)) == "create"


def test_setup_create_mode_inits_repo(tmp_path):
    wt = setup_worktree(str(tmp_path), "agent/run-1")
    assert wt == str(tmp_path)
    assert os.path.isdir(os.path.join(wt, ".git"))


def test_setup_edit_mode_creates_worktree(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(["init"], str(repo))
    _git(["-c", "user.email=a@b.c", "-c", "user.name=t",
          "commit", "--allow-empty", "-m", "init"], str(repo))
    (repo / "main.py").write_text("print(1)", encoding="utf-8")
    _git(["add", "-A"], str(repo))
    _git(["-c", "user.email=a@b.c", "-c", "user.name=t",
          "commit", "-m", "code"], str(repo))

    wt = setup_worktree(str(repo), "agent/run-1")
    assert wt != str(repo)
    assert os.path.isfile(os.path.join(wt, "main.py"))

    teardown_worktree(str(repo), wt)
    assert not os.path.isdir(wt)


def test_setup_edit_mode_non_git_dir_creates_worktree(tmp_path):
    """A source dir that is not a git repo must be snapshotted and isolated."""
    repo = tmp_path / "non_git_src"
    repo.mkdir()
    (repo / "main.py").write_text("print(42)", encoding="utf-8")
    # No .git — raw source tree

    wt = setup_worktree(str(repo), "agent/snap-1")

    # The agent gets a worktree, not the raw directory
    assert wt != str(repo)
    # The source file is present in the worktree
    assert os.path.isfile(os.path.join(wt, "main.py"))
    # The original directory is now a git repo (was snapshotted)
    assert os.path.isdir(os.path.join(str(repo), ".git"))

    teardown_worktree(str(repo), wt)


def test_setup_worktree_is_rerun_safe(tmp_path):
    """Calling setup_worktree twice on the same repo/branch must not raise."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(["init"], str(repo))
    _git(["-c", "user.email=a@b.c", "-c", "user.name=t",
          "commit", "--allow-empty", "-m", "init"], str(repo))
    (repo / "app.py").write_text("x = 1", encoding="utf-8")
    _git(["add", "-A"], str(repo))
    _git(["-c", "user.email=a@b.c", "-c", "user.name=t",
          "commit", "-m", "code"], str(repo))

    wt1 = setup_worktree(str(repo), "agent/rerun")
    assert os.path.isdir(wt1)

    # Second call with same branch must not raise
    wt2 = setup_worktree(str(repo), "agent/rerun")
    assert os.path.isdir(wt2)
    assert wt1 == wt2

    teardown_worktree(str(repo), wt2)
