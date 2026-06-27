# Agent Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Python orchestrator that loops Scout → Builder → Reviewer over existing AI CLIs (claude/codex/gemini), runs tests in an isolated git worktree, captures errors from stderr + optional Sentry, and repeats until tests pass and the Reviewer approves.

**Architecture:** LangGraph holds state and the loop. Each node shells out to an assigned CLI in headless mode (`cwd` = worktree); the CLI edits files itself. The orchestrator only routes, runs tests, gathers errors, and decides when to stop. Lives in a self-contained `orchestrator/` package at repo root with its own `pyproject.toml`; it does not touch the Tauri/TS code.

**Tech Stack:** Python 3.13, LangGraph, PyYAML (config), `requests` (Sentry), pytest. Subprocess drives the CLIs.

## Global Constraints

- Python 3.13 (`python --version` → 3.13.x).
- New code lives **only** under `orchestrator/` and `tests/`. Never modify `src/`, `src-tauri/`, or any TS/Rust file.
- All cross-task decision logic (route, parse, detect, format) must be **pure functions** unit-testable without real subprocesses or network.
- Sentry is **optional**: disabled by default; `SentryErrorSource.collect()` returns `[]` when not configured.
- Default role→CLI mapping (override in config): Scout=`claude`, Builder=`codex`, Reviewer=`gemini`.
- `max_iterations` default = **6**.
- Prompts are passed to CLIs via **stdin** by default (`prompt_via="stdin"`), with `prompt_via="arg"` as a per-agent option.
- Never run real model CLIs in tests. Tests point agent commands at a fake CLI script.
- Commit after every green step. Commit messages use Conventional Commits.

---

### Task 1: Project scaffold + config

**Files:**
- Create: `orchestrator/__init__.py`
- Create: `orchestrator/config.py`
- Create: `pyproject.toml`
- Create: `tests/__init__.py`
- Create: `tests/test_config.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AgentConfig(args: list[str], prompt_via: str = "stdin", timeout: int = 600)` (dataclass)
  - `SentryConfig(enabled: bool = False, base_url: str = "", token: str = "", org: str = "", project: str = "")` (dataclass)
  - `Config(agents: dict[str, AgentConfig], max_iterations: int = 6, test_command: list[str] | None = None, sentry: SentryConfig = ...)` (dataclass)
  - `default_config() -> Config`
  - `load_config(path: str | None) -> Config` — YAML overlay on defaults; `None` → defaults.

- [ ] **Step 1: Create `pyproject.toml`**

```toml
[project]
name = "maestro-orchestrator"
version = "0.1.0"
description = "Scout/Builder/Reviewer agent loop over AI CLIs"
requires-python = ">=3.13"
dependencies = [
    "langgraph>=0.2",
    "pyyaml>=6",
    "requests>=2.31",
]

[project.optional-dependencies]
dev = ["pytest>=8"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["orchestrator*"]
```

- [ ] **Step 2: Install deps**

Run: `python -m pip install -e ".[dev]"`
Expected: installs langgraph, pyyaml, requests, pytest without error.

- [ ] **Step 3: Create empty package markers**

Create `orchestrator/__init__.py` and `tests/__init__.py`, both empty.

- [ ] **Step 4: Write the failing test**

`tests/test_config.py`:
```python
from orchestrator.config import default_config, load_config, AgentConfig


def test_default_config_has_three_roles():
    cfg = default_config()
    assert set(cfg.agents) == {"scout", "builder", "reviewer"}
    assert cfg.max_iterations == 6
    assert cfg.sentry.enabled is False


def test_default_role_cli_mapping():
    cfg = default_config()
    assert cfg.agents["scout"].args[0] == "claude"
    assert cfg.agents["builder"].args[0] == "codex"
    assert cfg.agents["reviewer"].args[0] == "gemini"


def test_load_config_none_returns_defaults():
    cfg = load_config(None)
    assert cfg.max_iterations == 6


def test_load_config_overlays_yaml(tmp_path):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "max_iterations: 3\n"
        "agents:\n"
        "  builder:\n"
        "    args: [claude, -p]\n",
        encoding="utf-8",
    )
    cfg = load_config(str(p))
    assert cfg.max_iterations == 3
    assert cfg.agents["builder"].args == ["claude", "-p"]
    # untouched roles keep defaults
    assert cfg.agents["scout"].args[0] == "claude"
    assert isinstance(cfg.agents["reviewer"], AgentConfig)
```

- [ ] **Step 5: Run test to verify it fails**

Run: `python -m pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'orchestrator.config'`.

- [ ] **Step 6: Write minimal implementation**

`orchestrator/config.py`:
```python
from __future__ import annotations

from dataclasses import dataclass, field, replace

import yaml


@dataclass
class AgentConfig:
    args: list[str]
    prompt_via: str = "stdin"  # "stdin" | "arg"
    timeout: int = 600


@dataclass
class SentryConfig:
    enabled: bool = False
    base_url: str = ""
    token: str = ""
    org: str = ""
    project: str = ""


@dataclass
class Config:
    agents: dict[str, AgentConfig]
    max_iterations: int = 6
    test_command: list[str] | None = None
    sentry: SentryConfig = field(default_factory=SentryConfig)


def default_config() -> Config:
    return Config(
        agents={
            "scout": AgentConfig(args=["claude", "-p", "--dangerously-skip-permissions"]),
            "builder": AgentConfig(args=["codex", "exec"]),
            "reviewer": AgentConfig(args=["gemini", "-p"]),
        },
        max_iterations=6,
        test_command=None,
        sentry=SentryConfig(),
    )


def load_config(path: str | None) -> Config:
    cfg = default_config()
    if path is None:
        return cfg
    with open(path, "r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}

    if "max_iterations" in data:
        cfg = replace(cfg, max_iterations=int(data["max_iterations"]))
    if "test_command" in data:
        cfg = replace(cfg, test_command=list(data["test_command"]))
    if "agents" in data:
        for role, overrides in (data["agents"] or {}).items():
            base = cfg.agents.get(role, AgentConfig(args=[]))
            cfg.agents[role] = replace(
                base,
                **{k: v for k, v in overrides.items() if k in {"args", "prompt_via", "timeout"}},
            )
    if "sentry" in data:
        s = data["sentry"] or {}
        cfg = replace(cfg, sentry=replace(cfg.sentry, **{
            k: v for k, v in s.items()
            if k in {"enabled", "base_url", "token", "org", "project"}
        }))
    return cfg
```

- [ ] **Step 7: Run test to verify it passes**

Run: `python -m pytest tests/test_config.py -v`
Expected: 4 passed.

- [ ] **Step 8: Commit**

```bash
git add pyproject.toml orchestrator/__init__.py orchestrator/config.py tests/__init__.py tests/test_config.py
git commit -m "feat(orchestrator): project scaffold and config loader"
```

---

### Task 2: Executor — project detection + command runner

**Files:**
- Create: `orchestrator/executor.py`
- Create: `tests/test_executor.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ExecResult` TypedDict: `{command: list[str], stdout: str, stderr: str, returncode: int, timed_out: bool}`
  - `detect_test_command(project_dir: str) -> list[str] | None`
  - `run_command(command: list[str], cwd: str, timeout: int = 600) -> ExecResult`

- [ ] **Step 1: Write the failing test**

`tests/test_executor.py`:
```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_executor.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'orchestrator.executor'`.

- [ ] **Step 3: Write minimal implementation**

`orchestrator/executor.py`:
```python
from __future__ import annotations

import os
import subprocess
from typing import TypedDict


class ExecResult(TypedDict):
    command: list[str]
    stdout: str
    stderr: str
    returncode: int
    timed_out: bool


def detect_test_command(project_dir: str) -> list[str] | None:
    def has(name: str) -> bool:
        return os.path.exists(os.path.join(project_dir, name))

    if has("pyproject.toml") or has("requirements.txt") or has("setup.py"):
        return ["python", "-m", "pytest", "-q"]
    if has("package.json"):
        return ["npm", "test"]
    if has("Cargo.toml"):
        return ["cargo", "test"]
    return None


def run_command(command: list[str], cwd: str, timeout: int = 600) -> ExecResult:
    try:
        proc = subprocess.run(
            command,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
        )
        return ExecResult(
            command=command,
            stdout=proc.stdout,
            stderr=proc.stderr,
            returncode=proc.returncode,
            timed_out=False,
        )
    except subprocess.TimeoutExpired as exc:
        return ExecResult(
            command=command,
            stdout=exc.stdout or "" if isinstance(exc.stdout, str) else "",
            stderr=(exc.stderr or "" if isinstance(exc.stderr, str) else "") + "\n[timed out]",
            returncode=-1,
            timed_out=True,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_executor.py -v`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/executor.py tests/test_executor.py
git commit -m "feat(orchestrator): project detection and command runner"
```

---

### Task 3: Error sources — terminal + optional Sentry

**Files:**
- Create: `orchestrator/errors.py`
- Create: `tests/test_errors.py`

**Interfaces:**
- Consumes: `ExecResult` (Task 2), `SentryConfig` (Task 1).
- Produces:
  - `ErrorEvent` TypedDict: `{source: str, title: str, detail: str}`
  - `TerminalErrorSource(exec_result: ExecResult | None)` with `.collect() -> list[ErrorEvent]`
  - `SentryErrorSource(cfg: SentryConfig, http_get=...)` with `.collect() -> list[ErrorEvent]`
  - `format_errors(events: list[ErrorEvent]) -> str`

- [ ] **Step 1: Write the failing test**

`tests/test_errors.py`:
```python
from orchestrator.config import SentryConfig
from orchestrator.errors import (
    ErrorEvent,
    SentryErrorSource,
    TerminalErrorSource,
    format_errors,
)


def _exec(returncode, stderr="", stdout=""):
    return {
        "command": ["x"],
        "stdout": stdout,
        "stderr": stderr,
        "returncode": returncode,
        "timed_out": False,
    }


def test_terminal_source_no_error_on_success():
    src = TerminalErrorSource(_exec(0, stderr=""))
    assert src.collect() == []


def test_terminal_source_reports_nonzero_exit():
    src = TerminalErrorSource(_exec(1, stderr="Traceback: boom"))
    events = src.collect()
    assert len(events) == 1
    assert events[0]["source"] == "terminal"
    assert "boom" in events[0]["detail"]


def test_terminal_source_none_exec_is_empty():
    assert TerminalErrorSource(None).collect() == []


def test_sentry_disabled_returns_empty():
    src = SentryErrorSource(SentryConfig(enabled=False))
    assert src.collect() == []


def test_sentry_enabled_pulls_issues():
    cfg = SentryConfig(enabled=True, base_url="https://s.io/api/0",
                       token="t", org="o", project="p")

    def fake_get(url, headers):
        assert "o" in url and "p" in url
        assert headers["Authorization"] == "Bearer t"
        return [{"title": "NPE", "culprit": "app.main"}]

    src = SentryErrorSource(cfg, http_get=fake_get)
    events = src.collect()
    assert events[0]["source"] == "sentry"
    assert events[0]["title"] == "NPE"


def test_format_errors_empty():
    assert format_errors([]) == "No errors detected."


def test_format_errors_joins_events():
    events = [ErrorEvent(source="terminal", title="exit 1", detail="boom")]
    out = format_errors(events)
    assert "terminal" in out and "boom" in out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_errors.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'orchestrator.errors'`.

- [ ] **Step 3: Write minimal implementation**

`orchestrator/errors.py`:
```python
from __future__ import annotations

from typing import Callable, TypedDict

from orchestrator.config import SentryConfig
from orchestrator.executor import ExecResult


class ErrorEvent(TypedDict):
    source: str
    title: str
    detail: str


class TerminalErrorSource:
    def __init__(self, exec_result: ExecResult | None):
        self._exec = exec_result

    def collect(self) -> list[ErrorEvent]:
        ex = self._exec
        if ex is None or ex["returncode"] == 0:
            return []
        detail = (ex["stderr"] or ex["stdout"] or "").strip()
        return [ErrorEvent(
            source="terminal",
            title=f"exit {ex['returncode']}",
            detail=detail or "(no output)",
        )]


def _default_http_get(url: str, headers: dict) -> list[dict]:
    import requests

    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


class SentryErrorSource:
    def __init__(self, cfg: SentryConfig,
                 http_get: Callable[[str, dict], list[dict]] = _default_http_get):
        self._cfg = cfg
        self._http_get = http_get

    def collect(self) -> list[ErrorEvent]:
        cfg = self._cfg
        if not cfg.enabled:
            return []
        url = f"{cfg.base_url}/projects/{cfg.org}/{cfg.project}/issues/?query=is:unresolved"
        headers = {"Authorization": f"Bearer {cfg.token}"}
        try:
            issues = self._http_get(url, headers)
        except Exception as exc:  # network/Sentry failures are non-fatal
            return [ErrorEvent(source="sentry", title="sentry fetch failed", detail=str(exc))]
        return [
            ErrorEvent(source="sentry", title=i.get("title", "issue"),
                       detail=i.get("culprit", ""))
            for i in issues
        ]


def format_errors(events: list[ErrorEvent]) -> str:
    if not events:
        return "No errors detected."
    lines = []
    for e in events:
        lines.append(f"[{e['source']}] {e['title']}\n{e['detail']}".strip())
    return "\n\n".join(lines)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_errors.py -v`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/errors.py tests/test_errors.py
git commit -m "feat(orchestrator): terminal and optional Sentry error sources"
```

---

### Task 4: Worktree manager + mode detection

**Files:**
- Create: `orchestrator/worktree.py`
- Create: `tests/test_worktree.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `detect_mode(repo_path: str) -> str` — `"create"` if empty/no source files, else `"edit"`.
  - `setup_worktree(repo_path: str, branch: str) -> str` — returns the working directory path. For an existing git repo: a real `git worktree` off HEAD on `branch`. For an empty/non-git dir: `git init` in place and return `repo_path`.
  - `teardown_worktree(repo_path: str, worktree_path: str) -> None` — removes the worktree if it differs from `repo_path`; no-op otherwise.

- [ ] **Step 1: Write the failing test**

`tests/test_worktree.py`:
```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_worktree.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'orchestrator.worktree'`.

- [ ] **Step 3: Write minimal implementation**

`orchestrator/worktree.py`:
```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_worktree.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/worktree.py tests/test_worktree.py
git commit -m "feat(orchestrator): git worktree manager and mode detection"
```

---

### Task 5: CLI agent runner + lenient JSON parsing

**Files:**
- Create: `orchestrator/cli_agents.py`
- Create: `tests/test_cli_agents.py`
- Create: `tests/fake_cli.py`

**Interfaces:**
- Consumes: `Config`, `AgentConfig` (Task 1).
- Produces:
  - `AgentResult` dataclass: `role: str, raw_output: str, returncode: int, timed_out: bool`
  - `run_agent(role: str, prompt: str, cwd: str, config: Config) -> AgentResult` — builds command from `config.agents[role]`, sends `prompt` via stdin or as final arg, retries once on failure.
  - `extract_json_block(text: str) -> dict | None` — returns the last ```json fenced object, falling back to the last bare `{...}` object; `None` if none/parse fails.

- [ ] **Step 1: Write the fake CLI helper**

`tests/fake_cli.py`:
```python
"""A stand-in for a real AI CLI. Reads a prompt from stdin and emits
canned output controlled by argv, so the graph can be driven offline.

Usage in tests:
  command = [sys.executable, "tests/fake_cli.py", "--emit", "<text>"]
  command = [sys.executable, "tests/fake_cli.py", "--fail"]
  command = [sys.executable, "tests/fake_cli.py", "--touch", "<relpath>"]
"""
import argparse
import os
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--emit", default="")
    ap.add_argument("--touch", default="")
    ap.add_argument("--fail", action="store_true")
    args = ap.parse_args()

    _prompt = sys.stdin.read()  # consume stdin like a real CLI

    if args.touch:
        with open(args.touch, "w", encoding="utf-8") as fh:
            fh.write("generated\n")

    if args.emit:
        sys.stdout.write(args.emit)

    return 1 if args.fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Write the failing test**

`tests/test_cli_agents.py`:
```python
import sys

from orchestrator.config import AgentConfig, default_config
from orchestrator.cli_agents import AgentResult, extract_json_block, run_agent


def test_extract_json_fenced():
    text = 'noise\n```json\n{"approved": true, "notes": "ok"}\n```\ntail'
    assert extract_json_block(text) == {"approved": True, "notes": "ok"}


def test_extract_json_bare_fallback():
    text = 'prefix {"a": 1} suffix'
    assert extract_json_block(text) == {"a": 1}


def test_extract_json_none_when_absent():
    assert extract_json_block("no json here") is None


def test_extract_json_none_on_garbage():
    assert extract_json_block("```json\n{not valid}\n```") is None


def test_run_agent_emits_stdout(tmp_path):
    cfg = default_config()
    cfg.agents["scout"] = AgentConfig(
        args=[sys.executable, "tests/fake_cli.py", "--emit", "hello-plan"],
    )
    res = run_agent("scout", "do the thing", cwd=str(tmp_path), config=cfg)
    assert isinstance(res, AgentResult)
    assert res.returncode == 0
    assert "hello-plan" in res.raw_output


def test_run_agent_can_edit_files(tmp_path):
    target = tmp_path / "out.txt"
    cfg = default_config()
    cfg.agents["builder"] = AgentConfig(
        args=[sys.executable, "tests/fake_cli.py", "--touch", str(target)],
    )
    res = run_agent("builder", "write a file", cwd=str(tmp_path), config=cfg)
    assert res.returncode == 0
    assert target.read_text(encoding="utf-8").strip() == "generated"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python -m pytest tests/test_cli_agents.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'orchestrator.cli_agents'`.

- [ ] **Step 4: Write minimal implementation**

`orchestrator/cli_agents.py`:
```python
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass

from orchestrator.config import Config


@dataclass
class AgentResult:
    role: str
    raw_output: str
    returncode: int
    timed_out: bool


def _build_command(args: list[str], prompt: str, prompt_via: str) -> tuple[list[str], str | None]:
    if prompt_via == "arg":
        return [*args, prompt], None
    return list(args), prompt  # stdin


def _invoke(command: list[str], stdin_text: str | None, cwd: str, timeout: int) -> AgentResult:
    try:
        proc = subprocess.run(
            command, cwd=cwd, input=stdin_text, capture_output=True,
            text=True, timeout=timeout, shell=False,
        )
        return AgentResult(role="", raw_output=proc.stdout, returncode=proc.returncode, timed_out=False)
    except subprocess.TimeoutExpired:
        return AgentResult(role="", raw_output="", returncode=-1, timed_out=True)


def run_agent(role: str, prompt: str, cwd: str, config: Config) -> AgentResult:
    ac = config.agents[role]
    command, stdin_text = _build_command(ac.args, prompt, ac.prompt_via)

    result = _invoke(command, stdin_text, cwd, ac.timeout)
    if result.returncode != 0 or result.timed_out:
        result = _invoke(command, stdin_text, cwd, ac.timeout)  # retry once
    result.role = role
    return result


_FENCE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)


def extract_json_block(text: str) -> dict | None:
    candidates: list[str] = _FENCE.findall(text)
    if not candidates:
        start = text.rfind("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            candidates = [text[start:end + 1]]
    for raw in reversed(candidates):
        try:
            value = json.loads(raw)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            continue
    return None
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_cli_agents.py -v`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/cli_agents.py tests/test_cli_agents.py tests/fake_cli.py
git commit -m "feat(orchestrator): CLI agent runner and lenient JSON parsing"
```

---

### Task 6: State + prompt templates

**Files:**
- Create: `orchestrator/state.py`
- Create: `orchestrator/prompts.py`
- Create: `tests/test_prompts.py`

**Interfaces:**
- Consumes: `ExecResult` (Task 2), `ReviewVerdict` (defined here).
- Produces:
  - `ReviewVerdict` TypedDict: `{approved: bool, blocking: list[str], notes: str}`
  - `OrchestratorState` TypedDict (all fields listed in code below).
  - `scout_prompt(goal: str, mode: str, repo_listing: str) -> str`
  - `builder_prompt(goal: str, plan: str, errors_text: str, review_notes: str) -> str`
  - `reviewer_prompt(goal: str, plan: str, errors_text: str) -> str`

- [ ] **Step 1: Write the failing test**

`tests/test_prompts.py`:
```python
from orchestrator.prompts import builder_prompt, reviewer_prompt, scout_prompt


def test_scout_prompt_mentions_goal_and_mode():
    p = scout_prompt("add /health endpoint", "edit", "main.py\napp.py")
    assert "add /health endpoint" in p
    assert "edit" in p
    assert "main.py" in p


def test_builder_prompt_includes_errors_and_review():
    p = builder_prompt("goal", "the plan", "boom traceback", "fix the import")
    assert "the plan" in p
    assert "boom traceback" in p
    assert "fix the import" in p


def test_reviewer_prompt_requests_json_verdict():
    p = reviewer_prompt("goal", "plan", "no errors")
    assert "approved" in p
    assert "json" in p.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_prompts.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'orchestrator.prompts'`.

- [ ] **Step 3: Write minimal implementation**

`orchestrator/state.py`:
```python
from __future__ import annotations

from typing import Optional, TypedDict

from orchestrator.errors import ErrorEvent
from orchestrator.executor import ExecResult


class ReviewVerdict(TypedDict):
    approved: bool
    blocking: list[str]
    notes: str


class OrchestratorState(TypedDict, total=False):
    goal: str
    repo_path: str
    worktree_path: str
    branch: str
    mode: str  # "create" | "edit"
    plan: str
    iteration: int
    max_iterations: int
    last_exec: Optional[ExecResult]
    errors: list[ErrorEvent]
    review: Optional[ReviewVerdict]
    needs_rescout: bool
    history: list[str]
    outcome: Optional[str]  # "success" | "maxed" | "failed"
```

`orchestrator/prompts.py`:
```python
from __future__ import annotations


def scout_prompt(goal: str, mode: str, repo_listing: str) -> str:
    return (
        "You are the Scout. Survey the working directory and produce a short "
        "implementation plan for the Builder.\n"
        f"Mode: {mode} (create = scaffold a new project, edit = modify existing code).\n"
        f"Goal: {goal}\n\n"
        f"Files present:\n{repo_listing}\n\n"
        "Reply with a concise plan as a fenced ```json block: "
        '{\"plan\": \"...\", \"tasks\": [\"...\"]}.'
    )


def builder_prompt(goal: str, plan: str, errors_text: str, review_notes: str) -> str:
    return (
        "You are the Builder. Implement the plan by creating/editing files in the "
        "current working directory. Make all changes directly on disk.\n"
        f"Goal: {goal}\n\n"
        f"Plan:\n{plan}\n\n"
        f"Errors from the last test run (fix these):\n{errors_text}\n\n"
        f"Reviewer feedback (address these):\n{review_notes or '(none yet)'}\n\n"
        "When done, briefly summarise what you changed."
    )


def reviewer_prompt(goal: str, plan: str, errors_text: str) -> str:
    return (
        "You are the Reviewer. Judge whether the goal is met and the code is sound.\n"
        f"Goal: {goal}\n\n"
        f"Plan:\n{plan}\n\n"
        f"Latest test/error output:\n{errors_text}\n\n"
        "Reply ONLY with a fenced ```json block: "
        '{\"approved\": true|false, \"blocking\": [\"...\"], \"notes\": \"...\"}. '
        "Approve only if the goal is met and there are no blocking issues."
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_prompts.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/state.py orchestrator/prompts.py tests/test_prompts.py
git commit -m "feat(orchestrator): state schema and prompt templates"
```

---

### Task 7: Route decision function (pure)

**Files:**
- Create: `orchestrator/graph.py` (route only for now)
- Create: `tests/test_route.py`

**Interfaces:**
- Consumes: `OrchestratorState` (Task 6).
- Produces:
  - `route(state: OrchestratorState) -> str` — returns one of `"finalize_success"`, `"finalize_maxed"`, `"scout"`, `"builder"`.

Decision order (first match wins):
1. `errors` empty AND `review.approved` is True → `"finalize_success"`
2. `iteration >= max_iterations` → `"finalize_maxed"`
3. `needs_rescout` is True → `"scout"`
4. otherwise → `"builder"`

- [ ] **Step 1: Write the failing test**

`tests/test_route.py`:
```python
from orchestrator.graph import route


def base(**over):
    s = {
        "errors": [],
        "review": {"approved": False, "blocking": [], "notes": ""},
        "iteration": 0,
        "max_iterations": 6,
        "needs_rescout": False,
    }
    s.update(over)
    return s


def test_success_when_clean_and_approved():
    s = base(errors=[], review={"approved": True, "blocking": [], "notes": ""})
    assert route(s) == "finalize_success"


def test_not_success_when_errors_present():
    s = base(errors=[{"source": "terminal", "title": "exit 1", "detail": "x"}],
             review={"approved": True, "blocking": [], "notes": ""})
    assert route(s) == "builder"


def test_maxed_out():
    s = base(iteration=6, max_iterations=6)
    assert route(s) == "finalize_maxed"


def test_rescout_requested():
    s = base(needs_rescout=True)
    assert route(s) == "scout"


def test_default_loops_to_builder():
    assert route(base()) == "builder"


def test_success_takes_priority_over_maxed():
    s = base(iteration=6, errors=[],
             review={"approved": True, "blocking": [], "notes": ""})
    assert route(s) == "finalize_success"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_route.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'orchestrator.graph'`.

- [ ] **Step 3: Write minimal implementation**

`orchestrator/graph.py`:
```python
from __future__ import annotations

from orchestrator.state import OrchestratorState


def route(state: OrchestratorState) -> str:
    errors = state.get("errors") or []
    review = state.get("review") or {}
    approved = bool(review.get("approved"))

    if not errors and approved:
        return "finalize_success"
    if state.get("iteration", 0) >= state.get("max_iterations", 6):
        return "finalize_maxed"
    if state.get("needs_rescout"):
        return "scout"
    return "builder"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_route.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/graph.py tests/test_route.py
git commit -m "feat(orchestrator): pure route decision function"
```

---

### Task 8: Graph nodes + LangGraph wiring

**Files:**
- Modify: `orchestrator/graph.py` (add nodes + `build_graph`)
- Create: `tests/test_graph.py`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces:
  - `node_setup_worktree(state, config) -> dict`
  - `node_scout(state, config) -> dict`
  - `node_builder(state, config) -> dict`
  - `node_execute(state, config) -> dict`
  - `node_collect_errors(state, config) -> dict`
  - `node_reviewer(state, config) -> dict`
  - `node_finalize_success(state) -> dict` / `node_finalize_maxed(state) -> dict`
  - `build_graph(config: Config)` — compiled LangGraph app; `.invoke(initial_state)` runs the loop.

Node contracts (each returns a partial-state dict that LangGraph merges):
- `node_setup_worktree`: sets `worktree_path`, `mode`; ensures `iteration`/`history` initialised.
- `node_scout`: runs scout agent; sets `plan` (parsed `plan` field or raw output).
- `node_builder`: runs builder agent in `worktree_path`; increments `iteration`; resets `needs_rescout=False`.
- `node_execute`: detects/runs test command; sets `last_exec`. If no test command found, sets `last_exec=None` (treated as no terminal errors).
- `node_collect_errors`: builds `TerminalErrorSource(last_exec)` + `SentryErrorSource(config.sentry)`; sets `errors`.
- `node_reviewer`: runs reviewer agent; parses verdict via `extract_json_block`; sets `review` (parse failure → `{approved: False, blocking: ["unparseable review"], notes: raw}`).
- `node_finalize_*`: set `outcome`.

- [ ] **Step 1: Write the failing test (offline, fake CLIs)**

`tests/test_graph.py`:
```python
import sys

from orchestrator.config import AgentConfig, default_config
from orchestrator.graph import build_graph


def _fake(*extra):
    return AgentConfig(args=[sys.executable, "tests/fake_cli.py", *extra])


def _make_config(tmp_path, approved: bool):
    cfg = default_config()
    target = tmp_path / "result.txt"
    verdict = '{"approved": %s, "blocking": [], "notes": "ok"}' % (
        "true" if approved else "false")
    cfg.agents["scout"] = _fake("--emit", '```json\n{"plan": "make result.txt"}\n```')
    cfg.agents["builder"] = _fake("--touch", str(target))
    cfg.agents["reviewer"] = _fake("--emit", "```json\n" + verdict + "\n```")
    # no test command → no terminal errors
    cfg.test_command = [sys.executable, "-c", "pass"]
    return cfg, target


def test_graph_succeeds_when_reviewer_approves(tmp_path):
    cfg, target = _make_config(tmp_path, approved=True)
    app = build_graph(cfg)
    final = app.invoke({
        "goal": "make a file",
        "repo_path": str(tmp_path),
        "branch": "agent/test",
        "max_iterations": 4,
    })
    assert final["outcome"] == "success"
    assert target.exists()


def test_graph_maxes_out_when_never_approved(tmp_path):
    cfg, _ = _make_config(tmp_path, approved=False)
    app = build_graph(cfg)
    final = app.invoke({
        "goal": "make a file",
        "repo_path": str(tmp_path),
        "branch": "agent/test",
        "max_iterations": 2,
    })
    assert final["outcome"] == "maxed"
    assert final["iteration"] >= 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_graph.py -v`
Expected: FAIL — `ImportError: cannot import name 'build_graph'`.

- [ ] **Step 3: Append node + wiring implementation to `orchestrator/graph.py`**

```python
import os
from functools import partial

from langgraph.graph import END, START, StateGraph

from orchestrator.cli_agents import extract_json_block, run_agent
from orchestrator.config import Config
from orchestrator.errors import SentryErrorSource, TerminalErrorSource, format_errors
from orchestrator.executor import detect_test_command, run_command
from orchestrator.prompts import builder_prompt, reviewer_prompt, scout_prompt
from orchestrator.worktree import detect_mode, setup_worktree


def _listing(path: str) -> str:
    try:
        return "\n".join(sorted(os.listdir(path))) or "(empty)"
    except OSError:
        return "(empty)"


def node_setup_worktree(state, config: Config) -> dict:
    repo = state["repo_path"]
    branch = state.get("branch", "agent/run")
    mode = detect_mode(repo)
    wt = setup_worktree(repo, branch)
    return {
        "worktree_path": wt,
        "mode": mode,
        "iteration": state.get("iteration", 0),
        "max_iterations": state.get("max_iterations", config.max_iterations),
        "errors": [],
        "needs_rescout": False,
        "history": state.get("history", []),
    }


def node_scout(state, config: Config) -> dict:
    wt = state["worktree_path"]
    prompt = scout_prompt(state["goal"], state.get("mode", "edit"), _listing(wt))
    res = run_agent("scout", prompt, cwd=wt, config=config)
    parsed = extract_json_block(res.raw_output) or {}
    plan = parsed.get("plan") or res.raw_output.strip()
    return {"plan": plan, "needs_rescout": False,
            "history": state.get("history", []) + ["scout"]}


def node_builder(state, config: Config) -> dict:
    wt = state["worktree_path"]
    errors_text = format_errors(state.get("errors") or [])
    notes = (state.get("review") or {}).get("notes", "")
    prompt = builder_prompt(state["goal"], state.get("plan", ""), errors_text, notes)
    run_agent("builder", prompt, cwd=wt, config=config)
    return {"iteration": state.get("iteration", 0) + 1, "needs_rescout": False,
            "history": state.get("history", []) + ["builder"]}


def node_execute(state, config: Config) -> dict:
    wt = state["worktree_path"]
    cmd = config.test_command or detect_test_command(wt)
    if not cmd:
        return {"last_exec": None}
    return {"last_exec": run_command(cmd, cwd=wt)}


def node_collect_errors(state, config: Config) -> dict:
    terminal = TerminalErrorSource(state.get("last_exec"))
    sentry = SentryErrorSource(config.sentry)
    events = terminal.collect() + sentry.collect()
    return {"errors": events}


def node_reviewer(state, config: Config) -> dict:
    wt = state["worktree_path"]
    errors_text = format_errors(state.get("errors") or [])
    prompt = reviewer_prompt(state["goal"], state.get("plan", ""), errors_text)
    res = run_agent("reviewer", prompt, cwd=wt, config=config)
    parsed = extract_json_block(res.raw_output)
    if parsed is None or "approved" not in parsed:
        review = {"approved": False, "blocking": ["unparseable review"],
                  "notes": res.raw_output.strip()[:500]}
    else:
        review = {"approved": bool(parsed["approved"]),
                  "blocking": list(parsed.get("blocking", [])),
                  "notes": str(parsed.get("notes", ""))}
    return {"review": review,
            "history": state.get("history", []) + ["reviewer"]}


def node_finalize_success(state) -> dict:
    return {"outcome": "success"}


def node_finalize_maxed(state) -> dict:
    return {"outcome": "maxed"}


def build_graph(config: Config):
    from orchestrator.state import OrchestratorState

    g = StateGraph(OrchestratorState)
    g.add_node("setup", partial(node_setup_worktree, config=config))
    g.add_node("scout", partial(node_scout, config=config))
    g.add_node("builder", partial(node_builder, config=config))
    g.add_node("execute", partial(node_execute, config=config))
    g.add_node("collect_errors", partial(node_collect_errors, config=config))
    g.add_node("reviewer", partial(node_reviewer, config=config))
    g.add_node("finalize_success", node_finalize_success)
    g.add_node("finalize_maxed", node_finalize_maxed)

    g.add_edge(START, "setup")
    g.add_edge("setup", "scout")
    g.add_edge("scout", "builder")
    g.add_edge("builder", "execute")
    g.add_edge("execute", "collect_errors")
    g.add_edge("collect_errors", "reviewer")
    g.add_conditional_edges("reviewer", route, {
        "finalize_success": "finalize_success",
        "finalize_maxed": "finalize_maxed",
        "scout": "scout",
        "builder": "builder",
    })
    g.add_edge("finalize_success", END)
    g.add_edge("finalize_maxed", END)
    return g.compile()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_graph.py -v`
Expected: 2 passed. (LangGraph has a default recursion cap well above our loop; `max_iterations=2` finalizes long before it.)

- [ ] **Step 5: Run the whole suite**

Run: `python -m pytest -q`
Expected: all tests across Tasks 1–8 pass.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/graph.py tests/test_graph.py
git commit -m "feat(orchestrator): LangGraph nodes and loop wiring"
```

---

### Task 9: CLI entrypoint + run logging

**Files:**
- Create: `orchestrator/__main__.py`
- Create: `tests/test_main.py`

**Interfaces:**
- Consumes: `load_config` (Task 1), `build_graph` (Task 8).
- Produces:
  - `main(argv: list[str]) -> int` — parses `run --repo PATH --goal "..." [--config PATH] [--max-iters N] [--branch NAME]`, invokes the graph, prints outcome, returns `0` on success else `1`.

- [ ] **Step 1: Write the failing test**

`tests/test_main.py`:
```python
import sys

from orchestrator.__main__ import main


def test_main_runs_end_to_end(tmp_path, monkeypatch, capsys):
    # Point all three roles at the fake CLI via a config file.
    target = tmp_path / "done.txt"
    cfg = tmp_path / "cfg.yaml"
    cfg.write_text(
        "test_command: [%s, -c, pass]\n"
        "agents:\n"
        "  scout:\n"
        "    args: [%s, tests/fake_cli.py, --emit, plan]\n"
        "  builder:\n"
        "    args: [%s, tests/fake_cli.py, --touch, %s]\n"
        "  reviewer:\n"
        "    args: [%s, tests/fake_cli.py, --emit, '```json\\n{\"approved\": true, \"blocking\": [], \"notes\": \"ok\"}\\n```']\n"
        % (sys.executable, sys.executable, sys.executable, target, sys.executable),
        encoding="utf-8",
    )
    code = main([
        "run", "--repo", str(tmp_path), "--goal", "make done.txt",
        "--config", str(cfg), "--max-iters", "3", "--branch", "agent/x",
    ])
    out = capsys.readouterr().out
    assert code == 0
    assert "success" in out
    assert target.exists()


def test_main_returns_1_when_maxed(tmp_path):
    cfg = tmp_path / "cfg.yaml"
    cfg.write_text(
        "test_command: [%s, -c, pass]\n"
        "agents:\n"
        "  scout: {args: [%s, tests/fake_cli.py, --emit, plan]}\n"
        "  builder: {args: [%s, tests/fake_cli.py, --emit, built]}\n"
        "  reviewer: {args: [%s, tests/fake_cli.py, --emit, '```json\\n{\"approved\": false, \"blocking\": [\"x\"], \"notes\": \"no\"}\\n```']}\n"
        % (sys.executable, sys.executable, sys.executable, sys.executable),
        encoding="utf-8",
    )
    code = main([
        "run", "--repo", str(tmp_path), "--goal", "g",
        "--config", str(cfg), "--max-iters", "2",
    ])
    assert code == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_main.py -v`
Expected: FAIL — `ImportError`/`AttributeError` on `main`.

- [ ] **Step 3: Write minimal implementation**

`orchestrator/__main__.py`:
```python
from __future__ import annotations

import argparse
import sys

from orchestrator.config import load_config
from orchestrator.graph import build_graph


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="orchestrator")
    sub = parser.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="Run the Scout/Builder/Reviewer loop")
    run.add_argument("--repo", required=True)
    run.add_argument("--goal", required=True)
    run.add_argument("--config", default=None)
    run.add_argument("--max-iters", type=int, default=None)
    run.add_argument("--branch", default="agent/run")
    args = parser.parse_args(argv)

    config = load_config(args.config)
    if args.max_iters is not None:
        config.max_iterations = args.max_iters

    app = build_graph(config)
    initial = {
        "goal": args.goal,
        "repo_path": args.repo,
        "branch": args.branch,
        "max_iterations": config.max_iterations,
    }
    final = app.invoke(initial, config={"recursion_limit": 100})
    outcome = final.get("outcome", "failed")
    print(f"Orchestrator finished: {outcome} "
          f"(iterations={final.get('iteration', 0)})")
    return 0 if outcome == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_main.py -v`
Expected: 2 passed.

- [ ] **Step 5: Run the full suite + sanity-run the CLI**

Run: `python -m pytest -q`
Expected: all green.

Run (manual smoke, optional): `python -m orchestrator run --repo <empty-dir> --goal "create a hello.py that prints hi"`
Expected: drives the real CLIs; finishes with a `success`/`maxed` line.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/__main__.py tests/test_main.py
git commit -m "feat(orchestrator): CLI entrypoint for the agent loop"
```

---

### Task 10: README + run logging polish

**Files:**
- Create: `orchestrator/README.md`
- Modify: `orchestrator/graph.py` (add per-run log file)
- Create: `tests/test_logging.py`

**Interfaces:**
- Consumes: existing nodes.
- Produces:
  - `write_run_log(worktree_path: str, history: list[str], outcome: str | None) -> str` — writes a summary to `logs/orchestrator-run.log` under the worktree, returns the path.

- [ ] **Step 1: Write the failing test**

`tests/test_logging.py`:
```python
import os

from orchestrator.graph import write_run_log


def test_write_run_log_creates_file(tmp_path):
    path = write_run_log(str(tmp_path), ["scout", "builder", "reviewer"], "success")
    assert os.path.isfile(path)
    content = open(path, encoding="utf-8").read()
    assert "success" in content
    assert "scout" in content
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_logging.py -v`
Expected: FAIL — `ImportError: cannot import name 'write_run_log'`.

- [ ] **Step 3: Implement `write_run_log` and call it from finalize nodes**

Add to `orchestrator/graph.py`:
```python
def write_run_log(worktree_path: str, history: list[str], outcome: str | None) -> str:
    log_dir = os.path.join(worktree_path, "logs")
    os.makedirs(log_dir, exist_ok=True)
    path = os.path.join(log_dir, "orchestrator-run.log")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f"outcome: {outcome}\n")
        fh.write("steps:\n")
        for step in history:
            fh.write(f"  - {step}\n")
    return path
```

Update both finalize nodes to log (they have `worktree_path` and `history` in state):
```python
def node_finalize_success(state) -> dict:
    write_run_log(state["worktree_path"], state.get("history", []), "success")
    return {"outcome": "success"}


def node_finalize_maxed(state) -> dict:
    write_run_log(state["worktree_path"], state.get("history", []), "maxed")
    return {"outcome": "maxed"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_logging.py -v`
Expected: 1 passed.

- [ ] **Step 5: Write `orchestrator/README.md`**

```markdown
# Maestro Orchestrator

Standalone Python loop: **Scout → Builder → Reviewer** over your installed
AI CLIs (`claude`, `codex`, `gemini`). Runs tests in an isolated git
worktree, captures errors from stderr (+ optional Sentry), and repeats
until tests pass and the Reviewer approves.

## Install

    python -m pip install -e ".[dev]"

## Run

    python -m orchestrator run --repo PATH --goal "add a /health endpoint with a test"

Options: `--config cfg.yaml`, `--max-iters N`, `--branch NAME`.

## Config (`cfg.yaml`)

    max_iterations: 6
    test_command: [python, -m, pytest, -q]   # omit to auto-detect
    agents:
      scout:    { args: [claude, -p, --dangerously-skip-permissions] }
      builder:  { args: [codex, exec] }
      reviewer: { args: [gemini, -p] }
    sentry:
      enabled: false
      base_url: https://sentry.io/api/0
      token: ""
      org: ""
      project: ""

Each role maps to any CLI. Prompts go via stdin (`prompt_via: stdin`) by
default; use `prompt_via: arg` to pass the prompt as the final argument.

## Tests

    python -m pytest -q
```

- [ ] **Step 6: Run the full suite**

Run: `python -m pytest -q`
Expected: all tests green.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/README.md orchestrator/graph.py tests/test_logging.py
git commit -m "feat(orchestrator): run logging and usage README"
```

---

## Final verification

- [ ] Run `python -m pytest -q` — entire suite green.
- [ ] Confirm no files outside `orchestrator/`, `tests/`, `pyproject.toml`, and `docs/` were modified (`git status`).
- [ ] Optional real smoke test against an empty dir with a trivial goal.
