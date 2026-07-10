/* Conductor — an in-app auto-dispatch scheduler (not another LLM). When
 * enabled it keeps running agents fed with approved board cards: pair each
 * FREE agent (running, not already on a Doing card) with the next unassigned
 * "To do" card and dispatch it. In "auto" it also tops up the To do list from
 * Proposed so agents don't stall waiting for the human to approve.
 *
 * Pure planner (no DOM/IPC): given the mode, board, and agents it returns the
 * moves to make. The kanban controller executes them. Unit-testable. */

import type { Board } from "./board";

// "pipeline" is driven by planPipeline (see pipeline.ts), not planConductor.
export type ConductorMode = "off" | "semi" | "auto" | "pipeline";

export interface ConductorAgent {
  id: string;
  name: string;
  running: boolean;
}

export interface ConductorPlan {
  /** Card ids to approve (move Proposed → To do); auto mode only. */
  approvals: string[];
  /** Card → agent dispatches to perform (also move the card to Doing). */
  dispatches: { cardId: string; agentId: string; agentName: string }[];
}

const EMPTY: ConductorPlan = { approvals: [], dispatches: [] };
const byTitle = (board: Board, title: string) =>
  board.lists.find((l) => l.title.trim().toLowerCase() === title);

/** Decide this tick's moves. Deterministic; caller applies the result. */
export function planConductor(
  mode: ConductorMode,
  board: Board,
  agents: ConductorAgent[],
): ConductorPlan {
  // Only semi/auto run here; off does nothing and pipeline is planned elsewhere.
  if (mode !== "semi" && mode !== "auto") return EMPTY;

  const doing = byTitle(board, "doing");
  const busy = new Set(
    (doing?.cards ?? []).map((c) => c.assignee).filter((n): n is string => !!n),
  );
  // A free agent is running and not already tied to a card in Doing.
  const free = agents.filter((a) => a.running && !busy.has(a.name));
  if (!free.length) return EMPTY;

  const todo = byTitle(board, "to do");
  const queue = (todo?.cards ?? []).filter((c) => !c.assignee).map((c) => c.id);

  const approvals: string[] = [];
  if (mode === "auto" && queue.length < free.length) {
    const proposed = byTitle(board, "proposed");
    const need = free.length - queue.length;
    for (const c of (proposed?.cards ?? []).slice(0, need)) {
      approvals.push(c.id);
      queue.push(c.id); // approved cards are dispatchable this same tick
    }
  }

  const dispatches: ConductorPlan["dispatches"] = [];
  const n = Math.min(free.length, queue.length);
  for (let i = 0; i < n; i += 1) {
    dispatches.push({ cardId: queue[i], agentId: free[i].id, agentName: free[i].name });
  }
  return { approvals, dispatches };
}
