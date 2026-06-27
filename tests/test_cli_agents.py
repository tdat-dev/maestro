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


# FIX 5a — timeout must NOT be retried
def test_run_agent_does_not_retry_on_timeout(tmp_path):
    import time

    cfg = default_config()
    cfg.agents["scout"] = AgentConfig(
        args=[sys.executable, "tests/fake_cli.py", "--sleep", "10"],
        timeout=1,
    )
    start = time.monotonic()
    res = run_agent("scout", "prompt", cwd=str(tmp_path), config=cfg)
    elapsed = time.monotonic() - start
    assert res.timed_out
    # With retry this would take ≥2 s; without retry it completes in ~1 s.
    assert elapsed < 2.5, f"Retry guard failed — took {elapsed:.2f}s"


# FIX 6 — robust JSON extraction
def test_extract_json_with_brace_in_string():
    text = '```json\n{"approved": true, "notes": "added a } guard", "blocking": []}\n```'
    result = extract_json_block(text)
    assert result == {"approved": True, "notes": "added a } guard", "blocking": []}


def test_extract_json_nested_object():
    text = '```json\n{"approved": false, "blocking": [], "meta": {"k": 1}}\n```'
    result = extract_json_block(text)
    assert result == {"approved": False, "blocking": [], "meta": {"k": 1}}
