// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "./tasks";
import type { Ask } from "./askparse";

// The inbox reads tasks and drives panes through these modules; fake them so
// the DOM behaviour can be checked without PTYs or Tauri.
const state = vi.hoisted(() => ({
  tasks: [] as Task[],
  answered: [] as Array<[string, string]>,
  texts: [] as Array<[string, string]>,
  focused: [] as string[],
  listeners: [] as Array<() => void>,
}));
vi.mock("./tasks", () => ({
  allTasks: () => state.tasks,
  onTasksChange: (cb: () => void) => { state.listeners.push(cb); return () => {}; },
  answerOption: async (id: string, o: { key: string }) => { state.answered.push([id, o.key]); },
  answerText: async (id: string, t: string) => { state.texts.push([id, t]); },
}));
vi.mock("./panelayout", () => ({
  focusPane: (_ws: unknown, pane: { id: string; el: HTMLElement }) => {
    document.querySelectorAll(".focused").forEach((e) => e.classList.remove("focused"));
    pane.el.classList.add("focused");
    state.focused.push(pane.id);
  },
}));
vi.mock("./agentbridge", () => ({ revealPane: () => true }));

import { workspaces, setActiveWs } from "./appstate";
import { groupTasks, headline, rowLine, ago, initInbox, setInbox } from "./inbox";
import type { Workspace, Pane } from "./panetypes";

const RUN_ASK: Ask = {
  kind: "run", prompt: "Do you want to proceed?", detail: "npm run build",
  options: [
    { n: 1, label: "Yes", key: "1" },
    { n: 2, label: "Yes, and don't ask again", key: "2", always: true },
    { n: 3, label: "No, and tell Claude what to do differently", key: "\x1b", deny: true },
  ],
};
const task = (paneId: string, name: string, state: Task["status"]["state"], over: Partial<Task> = {}): Task => ({
  paneId, wsId: "ws-1", name, project: "maestro", branch: null, changedFiles: null, since: 0,
  status: { state, ask: state === "needs" ? RUN_ASK : null }, ...over,
});

describe("inbox helpers", () => {
  it("groups in queue order and keeps an empty Needs you group", () => {
    const g = groupTasks([task("w", "Eli", "working"), task("r", "Cy", "review")]);
    expect(g.map((x) => [x.state, x.tasks.length])).toEqual([["needs", 0], ["review", 1], ["working", 1]]);
  });

  it("writes the headline as a sentence", () => {
    expect(headline([task("a", "Ana", "needs"), task("b", "Bo", "needs"), task("c", "Cy", "review"), task("e", "Eli", "working")]))
      .toEqual({ lead: "2 agents need you.", rest: " 1 is ready to review, 1 is working." });
    expect(headline([task("e", "Eli", "working")]).lead).toBe("Nothing needs you.");
    expect(headline([]).lead).toBe("No agents yet.");
  });

  it("says what each agent wants on its row", () => {
    expect(rowLine(task("a", "Ana", "needs"))).toBe("Wants to run npm run build");
    expect(rowLine(task("c", "Cy", "review", { changedFiles: 3 }))).toBe("3 files changed");
    expect(rowLine(task("c", "Cy", "review", { changedFiles: 1 }))).toBe("1 file changed");
    expect(rowLine(task("h", "Hal", "idle"))).toBe("Waiting for a task");
    expect(ago(90_000)).toBe("2m");
  });
});

describe("inbox DOM", () => {
  let panes: Pane[];
  beforeEach(() => {
    document.body.className = "";
    document.body.innerHTML = `<div id="app"><header class="topbar"><div class="tb-center"></div></header></div>
      <input type="checkbox" id="setInboxUi">`;
    localStorage.clear();
    state.tasks = []; state.answered = []; state.texts = []; state.focused = []; state.listeners = [];
    panes = ["a", "e"].map((id) => ({ id, el: document.createElement("div"), color: "#f2b27a", term: { focus: () => {} } } as unknown as Pane));
    const ws = { id: "ws-1", name: "maestro", panes: new Map(panes.map((p) => [p.id, p])) } as unknown as Workspace;
    workspaces.clear(); workspaces.set("ws-1", ws); setActiveWs(ws);
    setInbox(false);
  });

  it("stays off until turned on, and remembers the choice", () => {
    initInbox();
    expect(document.querySelector(".inbox-queue")).toBeNull();
    const toggle = document.getElementById("setInboxUi") as HTMLInputElement;
    toggle.checked = true; toggle.dispatchEvent(new Event("change"));
    expect(document.body.classList.contains("inbox-ui")).toBe(true);
    expect(localStorage.getItem("maestro.inboxUi")).toBe("1");
    toggle.checked = false; toggle.dispatchEvent(new Event("change"));
    expect(document.querySelector(".inbox-queue")).toBeNull();
    expect(document.body.classList.contains("inbox-ui")).toBe(false);
  });

  it("puts the agent that needs you on the stage and answers it with a button", async () => {
    state.tasks = [task("a", "Ana", "needs"), task("e", "Eli", "working")];
    setInbox(true);
    expect(state.focused[0]).toBe("a");
    expect(document.querySelector(".inbox-head")!.textContent).toBe("1 agent needs you. 0 are ready to review, 1 is working.");
    expect(document.querySelectorAll(".iq-row")).toHaveLength(2);
    expect(document.querySelector(".ia-code")!.textContent).toBe("npm run build");
    (document.querySelector('.ia-opt[data-n="3"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(state.answered).toEqual([["a", "\x1b"]]);
    expect((document.querySelector(".inbox-ask") as HTMLElement).hidden).toBe(true);
  });

  it("sends a free-text answer and lets you tuck the card away", async () => {
    state.tasks = [task("a", "Ana", "needs")];
    setInbox(true);
    (document.querySelector(".ia-min") as HTMLButtonElement).click();
    expect(document.querySelector(".ia-chip")).not.toBeNull();
    (document.querySelector(".ia-chip") as HTMLButtonElement).click();
    const input = document.getElementById("iaFree") as HTMLInputElement;
    input.value = "use pnpm";
    document.querySelector(".ia-free")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(state.texts).toEqual([["a", "use pnpm"]]);
  });

  it("switches the stage from the queue and with Alt+arrows, and picks options with Alt+number", async () => {
    state.tasks = [task("a", "Ana", "needs"), task("e", "Eli", "working")];
    setInbox(true);
    (document.querySelector('.iq-row[data-id="e"]') as HTMLButtonElement).click();
    expect(state.focused[state.focused.length - 1]).toBe("e");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true }));
    expect(state.focused[state.focused.length - 1]).toBe("a");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", altKey: true }));
    await Promise.resolve();
    expect(state.answered).toEqual([["a", "1"]]);
  });

  it("shows the next permission prompt even when its wording matches the one just answered", async () => {
    state.tasks = [task("a", "Ana", "needs")];
    setInbox(true);
    (document.querySelector('.ia-opt[data-n="1"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect((document.querySelector(".inbox-ask") as HTMLElement).hidden).toBe(true);
    // Same "Do you want to proceed?" and options, different command, before any state change.
    state.tasks = [task("a", "Ana", "needs", { status: { state: "needs", ask: { ...RUN_ASK, detail: "npm test" } } })];
    state.listeners.forEach((cb) => cb());
    expect((document.querySelector(".inbox-ask") as HTMLElement).hidden).toBe(false);
    expect(document.querySelector(".ia-code")!.textContent).toBe("npm test");
  });

  it("does not wipe what you are typing when the tick re-renders", () => {
    state.tasks = [task("a", "Ana", "needs")];
    setInbox(true);
    const input = document.getElementById("iaFree") as HTMLInputElement;
    input.value = "half-typed";
    state.listeners.forEach((cb) => cb()); // a task change elsewhere
    expect((document.getElementById("iaFree") as HTMLInputElement).value).toBe("half-typed");
  });
});
