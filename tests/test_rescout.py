"""FIX 4 — verify that needs_rescout fires when reviewer rejects without errors."""
import sys

from orchestrator.config import AgentConfig, default_config
from orchestrator.graph import build_graph


def _fake(*extra):
    return AgentConfig(args=[sys.executable, "tests/fake_cli.py", *extra])


def test_rescout_fires_when_reviewer_rejects_without_errors(tmp_path):
    """Reviewer rejects but tests pass (no errors) → needs_rescout=True.
    History must contain at least two 'scout' entries."""
    cfg = default_config()
    reject_verdict = (
        '{"approved": false, "blocking": ["needs-more-detail"], "notes": "try harder"}'
    )
    cfg.agents["scout"] = _fake("--emit", '```json\n{"plan": "plan"}\n```')
    cfg.agents["builder"] = _fake("--emit", "built")
    cfg.agents["reviewer"] = _fake("--emit", "```json\n" + reject_verdict + "\n```")
    cfg.test_command = [sys.executable, "-c", "pass"]  # always passes → no errors
    cfg.max_iterations = 2

    app = build_graph(cfg)
    final = app.invoke({
        "goal": "do something",
        "repo_path": str(tmp_path),
        "branch": "agent/rescout-test",
        "max_iterations": 2,
    })
    history = final.get("history", [])
    scout_count = history.count("scout")
    assert scout_count >= 2, f"expected re-scout, got history={history}"
    assert final["outcome"] == "maxed"
