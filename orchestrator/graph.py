from __future__ import annotations

from orchestrator.state import OrchestratorState


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
