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
