// Live task list: one entry per agent pane, with its derived state.
//
// Runs next to the existing pane bookkeeping without changing it: every tick it
// reads each running pane's screen, asks git (throttled) whether the agent's
// branch has changes, and derives needs / review / working / idle / stopped.
// The new Queue UI renders from here; for now the old UI only borrows the
// status line for notifications.

import { workspaces } from "./appstate";
import { gitChangedFiles, repoDiff, sendInput } from "./ipc";
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
  /** What it was asked to do, when Maestro handed it the job. */
  title: string | null;
  /** One of several agents given the same job ("race 2/3"). */
  race: { id: string; n: number; of: number } | null;
  status: TaskStatus;
  changedFiles: number | null;
  /** Lines added and removed on its branch, when it has changes. */
  added: number | null;
  removed: number | null;
  /** ms the current state began, for "waiting 4m" and queue order. */
  since: number;
}

/** Screen rows read per pane: enough for a boxed prompt with its context. */
const SCREEN_LINES = 40;
/** How often each agent's branch is asked for changed files. */
export const DIFF_EVERY_MS = 5000;

/** One line in an agent's History: what happened and when. */
export interface HistoryEvent {
  at: number;
  kind: TaskState | "answer";
  text: string;
}
/** Enough to scroll back through a long session without growing forever. */
const HISTORY_MAX = 200;

const tasks = new Map<string, Task>();
const history = new Map<string, HistoryEvent[]>();
const diffs = new Map<string, { n: number | null; add: number | null; del: number | null; at: number; pending: boolean }>();

/** Lines added and removed in a unified diff (file headers don't count). */
export function countLines(diff: string): { add: number; del: number } {
  let add = 0, del = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) add++;
    else if (l.startsWith("-")) del++;
  }
  return { add, del };
}
const listeners = new Set<(list: Task[]) => void>();

/** Changed files can only be pinned on one agent when it has its own worktree;
 *  agents sharing a checkout share one diff, so for them it stays unknown. */
function changesFor(pane: Pane, now: number): { n: number | null; add: number | null; del: number | null } {
  const wt = pane.spec.worktree;
  if (!wt) return { n: null, add: null, del: null };
  const d = diffs.get(pane.id) ?? { n: null, add: null, del: null, at: 0, pending: false };
  if (!d.pending && now - d.at >= DIFF_EVERY_MS) {
    d.pending = true;
    gitChangedFiles(wt)
      .then(async (files) => {
        d.n = files.length;
        // Line counts only matter once there is something to review.
        if (!files.length) { d.add = d.del = 0; return; }
        const c = countLines(await repoDiff(wt));
        d.add = c.add; d.del = c.del;
      })
      .catch(() => { d.n = d.add = d.del = null; })
      .finally(() => { d.at = Date.now(); d.pending = false; });
  }
  diffs.set(pane.id, d);
  return d;
}

function toTask(ws: Workspace, pane: Pane, now: number): Task {
  const changes = changesFor(pane, now);
  const changedFiles = changes.n;
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
    title: pane.spec.title ?? null,
    race: pane.spec.race ?? null,
    status,
    changedFiles,
    added: changes.add,
    removed: changes.del,
    since: prev && prev.status.state === status.state ? prev.since : now,
  };
}

/** The History line for a task entering its current state, or null for
 *  states not worth a line of their own. */
export function describe(t: Pick<Task, "status" | "changedFiles">): string | null {
  const a = t.status.ask;
  switch (t.status.state) {
    case "needs":
      if (a?.kind === "run") return a.detail ? `Asked to run ${a.detail}` : "Asked to run a command";
      if (a?.kind === "edit") return a.detail ? `Asked to edit ${a.detail}` : "Asked to edit a file";
      return a ? `Asked: ${a.prompt}` : "Waited for you";
    case "review": {
      const n = t.changedFiles ?? 0;
      return `Finished with ${n} file${n === 1 ? "" : "s"} changed`;
    }
    case "working": return "Started working";
    case "stopped": return "Stopped";
    default: return null;
  }
}

function log(paneId: string, ev: HistoryEvent): void {
  const list = history.get(paneId) ?? [];
  const last = list[list.length - 1];
  // A burst of output flips working on and off; one "Started working" per stretch is enough.
  if (last && last.text === ev.text) return;
  if (ev.kind === "working" && last?.kind === "working") return;
  list.push(ev);
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
  history.set(paneId, list);
}

/** What an agent has done, oldest first. */
export function historyOf(paneId: string): HistoryEvent[] {
  return history.get(paneId) ?? [];
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
      const moved = !prev || prev.status.state !== next.status.state || prev.status.ask?.prompt !== next.status.ask?.prompt ||
        prev.status.ask?.detail !== next.status.ask?.detail;
      if (moved) {
        changed = true;
        const text = describe(next);
        if (text) log(pane.id, { at: now, kind: next.status.state, text });
      }
      tasks.set(pane.id, next);
    }
  for (const id of [...tasks.keys()])
    if (!seen.has(id)) { tasks.delete(id); diffs.delete(id); history.delete(id); changed = true; }
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
  log(paneId, { at: Date.now(), kind: "answer", text: `You picked “${option.label}”` });
  await sendInput(paneId, option.key);
}

/** Answer in free text, through the CLI's "type something" row when it has one. */
export async function answerText(paneId: string, text: string): Promise<void> {
  const ask = tasks.get(paneId)?.status.ask ?? null;
  log(paneId, { at: Date.now(), kind: "answer", text: `You said “${text.trim()}”` });
  for (const part of freeTextKeys(ask, text)) await sendInput(paneId, part);
}
