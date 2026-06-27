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
