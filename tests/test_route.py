from orchestrator.graph import route


def base(**over):
    s = {
        "errors": [],
        "review": {"approved": False, "blocking": [], "notes": ""},
        "iteration": 0,
        "max_iterations": 6,
        "needs_rescout": False,
    }
    s.update(over)
    return s


def test_success_when_clean_and_approved():
    s = base(errors=[], review={"approved": True, "blocking": [], "notes": ""})
    assert route(s) == "finalize_success"


def test_not_success_when_errors_present():
    s = base(errors=[{"source": "terminal", "title": "exit 1", "detail": "x"}],
             review={"approved": True, "blocking": [], "notes": ""})
    assert route(s) == "builder"


def test_maxed_out():
    s = base(iteration=6, max_iterations=6)
    assert route(s) == "finalize_maxed"


def test_rescout_requested():
    s = base(needs_rescout=True)
    assert route(s) == "scout"


def test_default_loops_to_builder():
    assert route(base()) == "builder"


def test_success_takes_priority_over_maxed():
    s = base(iteration=6, errors=[],
             review={"approved": True, "blocking": [], "notes": ""})
    assert route(s) == "finalize_success"


# FIX 5b — agent_failed takes top priority
def test_agent_failed_routes_to_finalize_failed():
    s = base(agent_failed=True)
    assert route(s) == "finalize_failed"


def test_agent_failed_overrides_success():
    """Even if tests pass and reviewer approves, a timeout surfaces as failed."""
    s = base(agent_failed=True, errors=[],
             review={"approved": True, "blocking": [], "notes": ""})
    assert route(s) == "finalize_failed"
