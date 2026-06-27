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
