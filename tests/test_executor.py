import sys

from orchestrator.executor import detect_test_command, run_command


def test_detect_python_project(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    assert detect_test_command(str(tmp_path)) == ["python", "-m", "pytest", "-q"]


def test_detect_node_project(tmp_path):
    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    assert detect_test_command(str(tmp_path)) == ["npm", "test"]


def test_detect_rust_project(tmp_path):
    (tmp_path / "Cargo.toml").write_text("[package]\n", encoding="utf-8")
    assert detect_test_command(str(tmp_path)) == ["cargo", "test"]


def test_detect_unknown_returns_none(tmp_path):
    assert detect_test_command(str(tmp_path)) is None


def test_run_command_captures_success(tmp_path):
    res = run_command([sys.executable, "-c", "print('hi')"], cwd=str(tmp_path))
    assert res["returncode"] == 0
    assert "hi" in res["stdout"]
    assert res["timed_out"] is False


def test_run_command_captures_stderr_and_exit(tmp_path):
    res = run_command(
        [sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(2)"],
        cwd=str(tmp_path),
    )
    assert res["returncode"] == 2
    assert "boom" in res["stderr"]


def test_run_command_times_out(tmp_path):
    res = run_command(
        [sys.executable, "-c", "import time; time.sleep(5)"],
        cwd=str(tmp_path),
        timeout=1,
    )
    assert res["timed_out"] is True
    assert res["returncode"] != 0
