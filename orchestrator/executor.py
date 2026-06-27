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
