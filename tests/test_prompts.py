from orchestrator.prompts import builder_prompt, reviewer_prompt, scout_prompt


def test_scout_prompt_mentions_goal_and_mode():
    p = scout_prompt("add /health endpoint", "edit", "main.py\napp.py")
    assert "add /health endpoint" in p
    assert "edit" in p
    assert "main.py" in p


def test_builder_prompt_includes_errors_and_review():
    p = builder_prompt("goal", "the plan", "boom traceback", "fix the import")
    assert "the plan" in p
    assert "boom traceback" in p
    assert "fix the import" in p


def test_reviewer_prompt_requests_json_verdict():
    p = reviewer_prompt("goal", "plan", "no errors")
    assert "approved" in p
    assert "json" in p.lower()
