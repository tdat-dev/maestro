"""FIX 5b — verify that a timed-out builder surfaces as outcome=='failed'."""
import sys

from orchestrator.config import AgentConfig, default_config
from orchestrator.graph import build_graph


def _fake(*extra):
    return AgentConfig(args=[sys.executable, "tests/fake_cli.py", *extra])


def test_builder_timeout_yields_failed_outcome(tmp_path):
    cfg = default_config()
    cfg.agents["scout"] = _fake("--emit", '```json\n{"plan": "plan"}\n```')
    # Builder sleeps 10 s; timeout is 1 s → timed_out=True → agent_failed=True
    cfg.agents["builder"] = AgentConfig(
        args=[sys.executable, "tests/fake_cli.py", "--sleep", "10"],
        timeout=1,
    )
    cfg.agents["reviewer"] = _fake(
        "--emit",
        '```json\n{"approved": false, "blocking": [], "notes": ""}\n```',
    )
    cfg.test_command = [sys.executable, "-c", "pass"]
    cfg.max_iterations = 3

    app = build_graph(cfg)
    final = app.invoke({
        "goal": "do something",
        "repo_path": str(tmp_path),
        "branch": "agent/timeout-test",
        "max_iterations": 3,
    })
    assert final["outcome"] == "failed"
