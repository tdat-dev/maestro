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
