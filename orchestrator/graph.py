from __future__ import annotations

import os
from functools import partial

from langgraph.graph import END, START, StateGraph

from orchestrator.cli_agents import extract_json_block, run_agent
from orchestrator.config import Config
from orchestrator.errors import SentryErrorSource, TerminalErrorSource, format_errors
from orchestrator.executor import detect_test_command, run_command
from orchestrator.prompts import builder_prompt, reviewer_prompt, scout_prompt
from orchestrator.state import OrchestratorState
from orchestrator.worktree import detect_mode, setup_worktree


def route(state: OrchestratorState) -> str:
    errors = state.get("errors") or []
    review = state.get("review") or {}
    approved = bool(review.get("approved"))

    if not errors and approved:
        return "finalize_success"
    if state.get("iteration", 0) >= state.get("max_iterations", 6):
        return "finalize_maxed"
    if state.get("needs_rescout"):
        return "scout"
    return "builder"


def _listing(path: str) -> str:
    try:
        return "\n".join(sorted(os.listdir(path))) or "(empty)"
    except OSError:
        return "(empty)"


def node_setup_worktree(state, config: Config) -> dict:
    repo = state["repo_path"]
    branch = state.get("branch", "agent/run")
    mode = detect_mode(repo)
    wt = setup_worktree(repo, branch)
    return {
        "worktree_path": wt,
        "mode": mode,
        "iteration": state.get("iteration", 0),
        "max_iterations": state.get("max_iterations", config.max_iterations),
        "errors": [],
        "needs_rescout": False,
        "history": state.get("history", []),
    }


def node_scout(state, config: Config) -> dict:
    wt = state["worktree_path"]
    prompt = scout_prompt(state["goal"], state.get("mode", "edit"), _listing(wt))
    res = run_agent("scout", prompt, cwd=wt, config=config)
    parsed = extract_json_block(res.raw_output) or {}
    plan = parsed.get("plan") or res.raw_output.strip()
    return {"plan": plan, "needs_rescout": False,
            "history": state.get("history", []) + ["scout"]}


def node_builder(state, config: Config) -> dict:
    wt = state["worktree_path"]
    errors_text = format_errors(state.get("errors") or [])
    notes = (state.get("review") or {}).get("notes", "")
    prompt = builder_prompt(state["goal"], state.get("plan", ""), errors_text, notes)
    run_agent("builder", prompt, cwd=wt, config=config)
    return {"iteration": state.get("iteration", 0) + 1, "needs_rescout": False,
            "history": state.get("history", []) + ["builder"]}


def node_execute(state, config: Config) -> dict:
    wt = state["worktree_path"]
    cmd = config.test_command or detect_test_command(wt)
    if not cmd:
        return {"last_exec": None}
    return {"last_exec": run_command(cmd, cwd=wt)}


def node_collect_errors(state, config: Config) -> dict:
    terminal = TerminalErrorSource(state.get("last_exec"))
    sentry = SentryErrorSource(config.sentry)
    events = terminal.collect() + sentry.collect()
    return {"errors": events}


def node_reviewer(state, config: Config) -> dict:
    wt = state["worktree_path"]
    errors_text = format_errors(state.get("errors") or [])
    prompt = reviewer_prompt(state["goal"], state.get("plan", ""), errors_text)
    res = run_agent("reviewer", prompt, cwd=wt, config=config)
    parsed = extract_json_block(res.raw_output)
    if parsed is None or "approved" not in parsed:
        review = {"approved": False, "blocking": ["unparseable review"],
                  "notes": res.raw_output.strip()[:500]}
    else:
        review = {"approved": bool(parsed["approved"]),
                  "blocking": list(parsed.get("blocking", [])),
                  "notes": str(parsed.get("notes", ""))}
    return {"review": review,
            "history": state.get("history", []) + ["reviewer"]}


def write_run_log(worktree_path: str, history: list[str], outcome: str | None) -> str:
    log_dir = os.path.join(worktree_path, "logs")
    os.makedirs(log_dir, exist_ok=True)
    path = os.path.join(log_dir, "orchestrator-run.log")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f"outcome: {outcome}\n")
        fh.write("steps:\n")
        for step in history:
            fh.write(f"  - {step}\n")
    return path


def node_finalize_success(state) -> dict:
    write_run_log(state["worktree_path"], state.get("history", []), "success")
    return {"outcome": "success"}


def node_finalize_maxed(state) -> dict:
    write_run_log(state["worktree_path"], state.get("history", []), "maxed")
    return {"outcome": "maxed"}


def build_graph(config: Config):
    from orchestrator.state import OrchestratorState

    g = StateGraph(OrchestratorState)
    g.add_node("setup", partial(node_setup_worktree, config=config))
    g.add_node("scout", partial(node_scout, config=config))
    g.add_node("builder", partial(node_builder, config=config))
    g.add_node("execute", partial(node_execute, config=config))
    g.add_node("collect_errors", partial(node_collect_errors, config=config))
    g.add_node("reviewer", partial(node_reviewer, config=config))
    g.add_node("finalize_success", node_finalize_success)
    g.add_node("finalize_maxed", node_finalize_maxed)

    g.add_edge(START, "setup")
    g.add_edge("setup", "scout")
    g.add_edge("scout", "builder")
    g.add_edge("builder", "execute")
    g.add_edge("execute", "collect_errors")
    g.add_edge("collect_errors", "reviewer")
    g.add_conditional_edges("reviewer", route, {
        "finalize_success": "finalize_success",
        "finalize_maxed": "finalize_maxed",
        "scout": "scout",
        "builder": "builder",
    })
    g.add_edge("finalize_success", END)
    g.add_edge("finalize_maxed", END)
    return g.compile()
