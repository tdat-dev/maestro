import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<[string, string]> = [];
let changed: Record<string, number> = {};
vi.mock("./ipc", () => ({
  gitChangedFiles: vi.fn(async (root: string) => Array.from({ length: changed[root] ?? 0 }, (_, i) => ({ path: `f${i}`, status: "M" }))),
  sendInput: vi.fn(async (id: string, data: string) => { sent.push([id, data]); }),
}));

import { workspaces } from "./appstate";
import { allTasks, answerOption, answerText, historyOf, onTasksChange, taskLine, taskOf, updateTasks } from "./tasks";
import type { Pane, Workspace } from "./panetypes";

const ASK = `
 Bash command

   npm run build

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for npm run build commands in D:\\p
   3. No, and tell Claude what to do differently (esc)
`;

function pane(id: string, name: string, over: Partial<Pane> & { screen?: string; worktree?: string } = {}): Pane {
  const { screen = "", worktree, ...rest } = over;
  return {
    id, el: {} as HTMLElement, running: true, spawnedAt: 0, lastOutputAt: 0, lastInputAt: 0,
    attention: false, attentionClearedAt: 0, attentionNotified: false, color: "#fff",
    spec: { program: "claude", args: [], cwd: "D:\\p", name, badge: "claude", color: "#fff", mono: "C", worktree, branch: worktree ? `${name.toLowerCase()}/x` : undefined },
    term: { snapshot: () => screen } as unknown as Pane["term"],
    ...rest,
  } as Pane;
}

function workspace(panes: Pane[]): Workspace {
  return { id: "ws-1", name: "maestro", dir: "D:\\p", repoRoot: "D:\\p", isolated: true, gridEl: {} as HTMLElement, tabEl: {} as HTMLElement, panes: new Map(panes.map((p) => [p.id, p])), layout: new Map() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  workspaces.clear(); sent.length = 0; changed = {};
  updateTasks(0); // drop tasks left from the previous test
});

describe("tasks", () => {
  it("derives each pane's state and orders the queue by what needs you", async () => {
    const now = 100_000;
    workspaces.set("ws-1", workspace([
      pane("a", "Ana", { screen: ASK, lastOutputAt: now - 30_000 }),
      pane("e", "Eli", { lastOutputAt: now - 500 }),
      pane("c", "Cy", { worktree: "D:\\wt\\cy", lastOutputAt: now - 30_000 }),
      pane("s", "Sam", { running: false }),
    ]));
    changed = { "D:\\wt\\cy": 3 };
    updateTasks(now);        // starts the diff lookup
    await flush();
    updateTasks(now + 10);   // …and uses it
    expect(allTasks().map((t) => [t.name, t.status.state])).toEqual([
      ["Ana", "needs"], ["Cy", "review"], ["Eli", "working"], ["Sam", "stopped"],
    ]);
    expect(taskOf("c")?.changedFiles).toBe(3);
    expect(taskLine("a")).toBe("Ana wants to run npm run build");
  });

  it("never marks a shared checkout ready to review: its diff isn't one agent's", async () => {
    workspaces.set("ws-1", workspace([pane("x", "Xo", { lastOutputAt: 0 })]));
    changed = { "D:\\p": 5 };
    updateTasks(100_000); await flush(); updateTasks(100_010);
    expect(taskOf("x")?.status.state).toBe("idle");
    expect(taskOf("x")?.changedFiles).toBeNull();
  });

  it("keeps when a state began, and tells listeners only about real changes", () => {
    const p = pane("a", "Ana", { screen: ASK, lastOutputAt: 0 });
    workspaces.set("ws-1", workspace([p]));
    const calls: number[] = [];
    const off = onTasksChange((l) => calls.push(l.length));
    updateTasks(1_000);
    updateTasks(2_000);
    expect(taskOf("a")?.since).toBe(1_000);
    expect(calls).toEqual([1]);
    (p.term as unknown as { snapshot: () => string }).snapshot = () => "";
    updateTasks(3_000);
    expect(taskOf("a")?.status.state).toBe("idle");
    expect(calls).toEqual([1, 1]);
    off();
  });

  it("forgets panes that were closed", () => {
    workspaces.set("ws-1", workspace([pane("a", "Ana")]));
    updateTasks(1);
    workspaces.clear();
    updateTasks(2);
    expect(allTasks()).toEqual([]);
  });

  it("answers with the exact keys the prompt showed", async () => {
    workspaces.set("ws-1", workspace([pane("a", "Ana", { screen: ASK })]));
    updateTasks(50_000);
    const ask = taskOf("a")!.status.ask!;
    await answerOption("a", ask.options[2]);
    await answerText("a", "use pnpm instead");
    expect(sent).toEqual([["a", "\x1b"], ["a", "use pnpm instead"], ["a", "\r"]]);
  });

  it("keeps a history of what each agent asked and what you answered", async () => {
    const p = pane("a", "Ana", { screen: ASK, lastOutputAt: 0 });
    workspaces.set("ws-1", workspace([p]));
    updateTasks(10_000);
    const opt = taskOf("a")!.status.ask!.options[0];
    await answerOption("a", opt);
    // Output bursts flip working on and off; only one "Started working" is kept.
    (p as { term: unknown }).term = { snapshot: () => "" };
    p.lastOutputAt = 20_000; updateTasks(20_100);
    p.lastOutputAt = 0; updateTasks(40_000);
    p.lastOutputAt = 40_500; updateTasks(40_600);
    await answerText("a", "  use pnpm ");
    expect(historyOf("a").map((e) => e.text)).toEqual([
      "Asked to run npm run build",
      "You picked “Yes”",
      "Started working",
      "You said “use pnpm”",
    ]);
  });
});
