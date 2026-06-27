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
    # Retry only on non-zero exit code; never retry a timeout (would double latency).
    if result.returncode != 0 and not result.timed_out:
        result = _invoke(command, stdin_text, cwd, ac.timeout)
    result.role = role
    return result


_FENCE_RE = re.compile(r"```json\s*\{", re.DOTALL)


def extract_json_block(text: str) -> dict | None:  # type: ignore[type-arg]
    """Return the last valid JSON object in *text*.

    Strategy:
    1. Prefer fence-anchored positions (```json fences always point at the
       outermost ``{``); try them last-to-first so the last fence wins when
       multiple fences are present.
    2. Fallback: scan bare ``{`` positions left-to-right, skipping past each
       decoded object so nested children are never mistaken for top-level
       ones, and keep the LAST top-level object.

    ``json.JSONDecoder.raw_decode`` handles nested braces and ``}`` inside
    strings correctly, so the full object is always returned regardless of
    how many closing braces appear inside string values.
    """
    decoder = json.JSONDecoder()

    # --- Pass 1: fence-anchored positions (preferred) ---
    fence_positions = [m.end() - 1 for m in _FENCE_RE.finditer(text)]
    for idx in reversed(fence_positions):
        try:
            value, _ = decoder.raw_decode(text, idx)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            continue

    # --- Pass 2: bare '{' positions, outermost & last-wins ---
    result: dict | None = None  # type: ignore[type-arg]
    idx = 0
    n = len(text)
    while idx < n:
        if text[idx] != "{":
            idx += 1
            continue
        try:
            value, end = decoder.raw_decode(text, idx)
        except json.JSONDecodeError:
            idx += 1
            continue
        if isinstance(value, dict):
            result = value
        # Skip past the decoded object so its nested braces aren't reconsidered.
        idx = max(end, idx + 1)

    return result
