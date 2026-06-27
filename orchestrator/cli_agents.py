from __future__ import annotations

import json
import os
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


def _resolve_command(command: list[str]) -> list[str]:
    """Resolve relative file paths in command args to absolute so subprocess
    can find them regardless of the cwd it is launched with."""
    return [
        os.path.abspath(part) if (i > 0 and not os.path.isabs(part) and os.path.exists(part)) else part
        for i, part in enumerate(command)
    ]


def _invoke(command: list[str], stdin_text: str | None, cwd: str, timeout: int) -> AgentResult:
    command = _resolve_command(command)
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


def extract_json_block(text: str) -> dict | None:  # type: ignore[type-arg]
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
