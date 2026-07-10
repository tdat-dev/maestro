/* Pipelines — cards flow through work stages (Build → Test → Review) between
 * the "To do" entry and "Done". When the conductor is in pipeline mode it hands
 * each card in a work stage to a free agent with a STAGE-SPECIFIC prompt, and
 * the agent moves the card to the next stage when finished. The conductor
 * detects that hand-off (the card changed stage) and clears the assignee so the
 * next stage can be picked up — possibly by a different agent.
 *
 * Pure: no DOM/IPC. planPipeline + helpers are unit-tested; kanban applies. */

import type { Board, Card } from "./board";

export interface PipelineStage {
  title: string;
  instruction: string;
}

export const ENTRY = "To do";
export const TERMINAL = "Done";

export const DEFAULT_PIPELINE: PipelineStage[] = [
  { title: "Build", instruction: "Implement this task end to end." },
  { title: "Test", instruction: "Write and run tests for this task; fix any failures." },
  {
    title: "Review",
    instruction: "Review the change for correctness, bugs, and clarity; fix issues you find.",
  },
];

const norm = (s: string) => s.trim().toLowerCase();

/** Ordered titles a card can be dispatched from: entry + every work stage. */
export function dispatchStages(pipeline: PipelineStage[]): string[] {
  return [ENTRY, ...pipeline.map((s) => s.title)];
}

/** The stage a card should advance to when its current stage is finished. A
 *  To-do card enters the first work stage; the last work stage goes to Done. */
export function nextTitle(pipeline: PipelineStage[], current: string): string {
  const c = norm(current);
  if (c === norm(ENTRY)) return pipeline[0]?.title ?? TERMINAL;
  const i = pipeline.findIndex((s) => norm(s.title) === c);
  if (i < 0) return TERMINAL;
  return pipeline[i + 1]?.title ?? TERMINAL;
}

/** The stage instruction for a list title, or null if it isn't a work stage. */
export function stageFor(pipeline: PipelineStage[], title: string): PipelineStage | null {
  return pipeline.find((s) => norm(s.title) === norm(title)) ?? null;
}

/** The dispatch text for a card entering `currentTitle`. `base` is the plain
 *  task text (dispatchPrompt). Adds the stage's instruction and where to move
 *  the card when done. For the To-do entry the "stage" is the first work stage. */
export function pipelinePrompt(
  base: string,
  pipeline: PipelineStage[],
  currentTitle: string,
): string {
  // From To do the work is the first stage; from a work stage it's that stage.
  const effective =
    norm(currentTitle) === norm(ENTRY) ? pipeline[0] : stageFor(pipeline, currentTitle);
  if (!effective) return base;
  const next = nextTitle(pipeline, effective.title);
  const move =
    next === TERMINAL
      ? `call card_done with a one-line summary`
      : `use the maestro card_move tool to move this card to "${next}"`;
  return (
    base +
    `\n\nPipeline stage — ${effective.title}: ${effective.instruction} ` +
    `When finished, ${move}.`
  );
}

const byTitle = (board: Board, title: string) =>
  board.lists.find((l) => norm(l.title) === norm(title));

/** Card ids whose assignee should be cleared because they moved to a different
 *  stage than the one they were dispatched into (a hand-off completed). */
export function staleAssignments(board: Board, assigned: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [cardId, atList] of assigned) {
    let cur: string | null = null;
    for (const l of board.lists) if (l.cards.some((c) => c.id === cardId)) cur = l.title;
    // Gone, or moved to a different list than where it was assigned → stale.
    if (cur === null || norm(cur) !== norm(atList)) out.push(cardId);
  }
  return out;
}

export interface PipelineAgent {
  id: string;
  name: string;
  running: boolean;
}
export interface PipelineDispatch {
  cardId: string;
  agentId: string;
  agentName: string;
  fromTitle: string; // the list the card is currently in
}
export interface PipelinePlan {
  unassign: string[]; // cards to clear (stale hand-offs)
  dispatches: PipelineDispatch[];
}

/** Plan one pipeline tick. `assigned` maps in-flight card id → the stage it was
 *  dispatched into (external memory the conductor keeps between ticks). */
export function planPipeline(
  board: Board,
  agents: PipelineAgent[],
  pipeline: PipelineStage[],
  assigned: Map<string, string>,
): PipelinePlan {
  const unassign = staleAssignments(board, assigned);
  const stale = new Set(unassign);

  // A card counts as "assigned" only if its assignee is set AND it isn't stale.
  const effectiveAssignee = (c: Card) => (stale.has(c.id) ? undefined : c.assignee);

  // Busy agents own a non-stale card in a dispatchable stage.
  const busy = new Set<string>();
  for (const title of dispatchStages(pipeline)) {
    const list = byTitle(board, title);
    for (const c of list?.cards ?? []) {
      const a = effectiveAssignee(c);
      if (a) busy.add(a);
    }
  }
  const free = agents.filter((a) => a.running && !busy.has(a.name));
  if (!free.length) return { unassign, dispatches: [] };

  // Dispatch queue: unassigned cards across dispatchable stages, earliest
  // stage first so nothing is starved at the front of the line.
  const queue: { cardId: string; fromTitle: string }[] = [];
  for (const title of dispatchStages(pipeline)) {
    const list = byTitle(board, title);
    for (const c of list?.cards ?? []) {
      if (!effectiveAssignee(c)) queue.push({ cardId: c.id, fromTitle: title });
    }
  }

  const dispatches: PipelineDispatch[] = [];
  const n = Math.min(free.length, queue.length);
  for (let i = 0; i < n; i += 1) {
    dispatches.push({
      cardId: queue[i].cardId,
      agentId: free[i].id,
      agentName: free[i].name,
      fromTitle: queue[i].fromTitle,
    });
  }
  return { unassign, dispatches };
}
