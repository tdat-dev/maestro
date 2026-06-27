import sys

from orchestrator.__main__ import main


def test_main_runs_end_to_end(tmp_path, monkeypatch, capsys):
    # Point all three roles at the fake CLI via a config file.
    target = tmp_path / "done.txt"
    cfg = tmp_path / "cfg.yaml"
    cfg.write_text(
        "test_command: [%s, -c, pass]\n"
        "agents:\n"
        "  scout:\n"
        "    args: [%s, tests/fake_cli.py, --emit, plan]\n"
        "  builder:\n"
        "    args: [%s, tests/fake_cli.py, --touch, %s]\n"
        "  reviewer:\n"
        "    args: [%s, tests/fake_cli.py, --emit, '```json\\n{\"approved\": true, \"blocking\": [], \"notes\": \"ok\"}\\n```']\n"
        % (sys.executable, sys.executable, sys.executable, target, sys.executable),
        encoding="utf-8",
    )
    code = main([
        "run", "--repo", str(tmp_path), "--goal", "make done.txt",
        "--config", str(cfg), "--max-iters", "3", "--branch", "agent/x",
    ])
    out = capsys.readouterr().out
    assert code == 0
    assert "success" in out
    assert target.exists()


def test_main_returns_1_when_maxed(tmp_path):
    cfg = tmp_path / "cfg.yaml"
    cfg.write_text(
        "test_command: [%s, -c, pass]\n"
        "agents:\n"
        "  scout: {args: [%s, tests/fake_cli.py, --emit, plan]}\n"
        "  builder: {args: [%s, tests/fake_cli.py, --emit, built]}\n"
        "  reviewer: {args: [%s, tests/fake_cli.py, --emit, '```json\\n{\"approved\": false, \"blocking\": [\"x\"], \"notes\": \"no\"}\\n```']}\n"
        % (sys.executable, sys.executable, sys.executable, sys.executable),
        encoding="utf-8",
    )
    code = main([
        "run", "--repo", str(tmp_path), "--goal", "g",
        "--config", str(cfg), "--max-iters", "2",
    ])
    assert code == 1
