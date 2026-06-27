import os

from orchestrator.graph import write_run_log


def test_write_run_log_creates_file(tmp_path):
    path = write_run_log(str(tmp_path), ["scout", "builder", "reviewer"], "success")
    assert os.path.isfile(path)
    content = open(path, encoding="utf-8").read()
    assert "success" in content
    assert "scout" in content
