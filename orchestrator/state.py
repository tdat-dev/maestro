from __future__ import annotations

from typing import Optional, TypedDict

from orchestrator.errors import ErrorEvent
from orchestrator.executor import ExecResult


class ReviewVerdict(TypedDict):
    approved: bool
    blocking: list[str]
    notes: str


# All channels are last-write-wins (no Annotated[..., add] reducers). This is
# correct because the graph is strictly sequential; a future parallel branch
# writing history/errors would need an add reducer to merge concurrent updates.
class OrchestratorState(TypedDict, total=False):
    goal: str
    repo_path: str
    worktree_path: str
    branch: str
    mode: str  # "create" | "edit"
    plan: str
    iteration: int
    max_iterations: int
    last_exec: Optional[ExecResult]
    errors: list[ErrorEvent]
    review: Optional[ReviewVerdict]
    needs_rescout: bool
    agent_failed: bool  # set True when builder or reviewer times out
    history: list[str]
    outcome: Optional[str]  # "success" | "maxed" | "failed"
