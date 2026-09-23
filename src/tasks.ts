// Live task list: one entry per agent pane, with its derived state.
//
// Runs next to the existing pane bookkeeping without changing it: every tick it
// reads each running pane's screen, asks git (throttled) whether the agent's
// branch has changes, and derives needs / review / working / idle / stopped.
// The new Queue UI renders from here; for now the old UI only borrows the
// status line for notifications.

import { workspaces } from "./appstate";
import { gitChangedFiles, sendInput } from "./ipc";
import { freeTextKeys, type AskOption } from "./askparse";
import { deriveTaskState, statusLine, type TaskState, type TaskStatus } from "./taskstate";
import type { Pane, Workspace } from "./panetypes";

export interface Task {
  paneId: string;
  wsId: string;
  name: string;
  /** Workspace name, which is the project the agent works in. */
  project: string;
  branch: string | null;
  status: TaskStatus;
  changedFiles: number | null;
  /** ms the current state began, for "waiting 4m" and queue order. */
  since: number;
}

/** Screen rows read per pane: enough for a boxed prompt with its context. */
const SCREEN_LINES = 40;
/** How often each agent's branch is asked for changed files. */
export const DIFF_EVERY_MS = 5000;

const tasks = new Map<string, Task>();
const diffs = new Map<string, { n: number | null; at: number; pending: boolean }>();
const listeners = new Set<(list: Task[]) => void>();

/** Changed files can only be pinned on one agent when it has its own worktree;
 *  agents sharing a checkout share one diff, so for them it stays unknown. */
function changedFilesFor(pane: Pane, now: number): number | null {
  const wt = pane.spec.worktree;
  if (!wt) return null;
  const d = diffs.get(pane.id) ?? { n: null, at: 0, pending: false };
  if (!d.pending && now - d.at >= DIFF_EVERY_MS) {
    d.pending = true;
    gitChangedFiles(wt)
      .then((files) => { d.n = files.length; })
      .catch(() => { d.n = null; })
      .finally(() => { d.at = Date.now(); d.pending = false; });
  }
  diffs.set(pane.id, d);
  return d.n;
}

function toTask(ws: Workspace, pane: Pane, now: number): Task {
  const changedFiles = changedFilesFor(pane, now);
  const status = deriveTaskState(
    {
      running: pane.running,
      lastOutputAt: pane.lastOutputAt,
      screen: pane.running ? pane.term.snapshot(SCREEN_LINES) : "",
      changedFiles,
    },
    now,
  );
  const prev = tasks.get(pane.id);
  return {
    paneId: pane.id,
    wsId: ws.id,
    name: pane.spec.name,
    project: ws.name,
    branch: pane.spec.branch ?? null,
    status,
    changedFiles,
    since: prev && prev.status.state === status.state ? prev.since : now,
  };
}

/** Re-derive every task. Call once per tick; cheap when nothing runs. */
export function updateTasks(now: number = Date.now()): void {
  let changed = false;
  const seen = new Set<string>();
  for (const ws of workspaces.values())
    for (const pane of ws.panes.values()) {
      seen.add(pane.id);
      const next = toTask(ws, pane, now);
      const prev = tasks.get(pane.id);
      if (!prev || prev.status.state !== next.status.state || prev.status.ask?.prompt !== next.status.ask?.prompt) changed = true;
      tasks.set(pane.id, next);
    }
  for (const id of [...tasks.keys()])
    if (!seen.has(id)) { tasks.delete(id); diffs.delete(id); changed = true; }
  if (changed && listeners.size) {
    const list = allTasks();
    for (const cb of listeners) cb(list);
  }
}

const RANK: Record<TaskState, number> = { needs: 0, review: 1, working: 2, idle: 3, stopped: 4 };

/** Every task, the queue's order: what needs you first, longest waiting first. */
export function allTasks(): Task[] {
  return [...tasks.values()].sort((a, b) => RANK[a.status.state] - RANK[b.status.state] || a.since - b.since);
}

export function taskOf(paneId: string): Task | undefined {
  return tasks.get(paneId);
}

/** Plain-words line for a pane ("Ana wants to run npm test"), or null if unknown. */
export function taskLine(paneId: string): string | null {
  const t = tasks.get(paneId);
  return t ? statusLine(t.name, t.status) : null;
}

/** Be told when any task changes state or starts asking something new. */
export function onTasksChange(cb: (list: Task[]) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Pick an option of the prompt currently on the agent's screen. */
export async function answerOption(paneId: string, option: AskOption): Promise<void> {
  await sendInput(paneId, option.key);
}

/** Answer in free text, through the CLI's "type something" row when it has one. */
export async function answerText(paneId: string, text: string): Promise<void> {
  const ask = tasks.get(paneId)?.status.ask ?? null;
  for (const part of freeTextKeys(ask, text)) await sendInput(paneId, part);
}
