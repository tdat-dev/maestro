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
  reviewed: [] as Array<string | null>,
}));
vi.mock("./diffview", () => ({
  createDiffView: () => ({
    mount: (body: HTMLElement) => { body.innerHTML = '<div class="dv-root"></div>'; },
    setContext: (ctx: { dir: string | null }) => { state.reviewed.push(ctx.dir); },
    show: () => {},
  }),
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
vi.mock("./zoom", () => ({ paneFont: (_ws: unknown, bump = 0) => 13 + bump }));
vi.mock("./ipc", () => ({ resizePty: async () => {} }));
vi.mock("./switcher", () => ({ openSwitcher: () => {} }));
vi.mock("./spawnmodal", () => ({ openModal: () => {} }));
vi.mock("./settingsmodal", () => ({ openSettings: () => {} }));
vi.mock("./dock", () => ({ dockToggle: () => {} }));

import { workspaces, setActiveWs } from "./appstate";
import { groupTasks, headline, rowLine, ago, togglePin, splitTiles, fillPins, shortLabel, isYesNo, initInbox, setInbox } from "./inbox";
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

  it("pins up to four agents for Split and never pushes out the one on the stage", () => {
    expect(togglePin(["a", "b"], "b")).toEqual(["a"]);
    expect(togglePin(["a", "b", "c", "d"], "e", "a")).toEqual(["a", "c", "d", "e"]);
    expect(togglePin(["a", "b", "c", "d"], "e", "b")).toEqual(["b", "c", "d", "e"]);
  });

  it("puts a plain permission prompt on one row with short button words", () => {
    expect(isYesNo(RUN_ASK)).toBe(true);
    expect(RUN_ASK.options.map(shortLabel)).toEqual(["Allow", "Always allow here", "Deny"]);
    expect(isYesNo({ kind: "question", options: RUN_ASK.options })).toBe(false);
  });

  it("fills Split from the queue without moving the agents already there", () => {
    expect(fillPins([], ["a", "b", "c", "d", "e"], new Set())).toEqual(["a", "b", "c", "d"]);
    expect(fillPins(["c", "a"], ["a", "b", "c"], new Set())).toEqual(["c", "a", "b"]);
    expect(fillPins(["a", "gone"], ["a", "b", "c"], new Set(["b"]))).toEqual(["a", "c"]);
  });

  it("lays two terminals side by side", () => {
    const [l, r] = splitTiles(2, { width: 1012, height: 600 });
    expect([l.x, l.w, r.x, r.w, l.h]).toEqual([0, 498, 514, 498, 600]);
  });
});

describe("inbox DOM", () => {
  let panes: Pane[];
  beforeEach(() => {
    document.body.className = "";
    document.body.innerHTML = `<div id="app"><header class="topbar"><div class="tb-center"></div></header></div>
      <input type="checkbox" id="setInboxUi">`;
    localStorage.clear();
    state.tasks = []; state.answered = []; state.texts = []; state.focused = []; state.listeners = []; state.reviewed = [];
    panes = ["a", "e"].map((id) => ({
      id, el: document.createElement("div"), color: "#f2b27a", running: false,
      spec: { name: id === "a" ? "Ana" : "Eli", cwd: "D:/maestro", worktree: `D:/wt/${id}`, branch: `maestro/${id}` },
      term: { focus: () => {}, setFontSize: () => {}, fit: () => ({ cols: 80, rows: 24 }) },
    } as unknown as Pane));
    const gridEl = document.createElement("div");
    panes.forEach((p) => {
      p.el.className = "pane";
      p.el.innerHTML = '<div class="pane-bar"><span class="pb-sp"></span><span data-where></span></div>';
      gridEl.appendChild(p.el);
    });
    const main = document.createElement("main");
    main.id = "workspaces";
    main.appendChild(gridEl);
    document.getElementById("app")!.appendChild(main);
    const ws = { id: "ws-1", name: "maestro", gridEl, panes: new Map(panes.map((p) => [p.id, p])) } as unknown as Workspace;
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
    // Allow sits last and brightest, as in the design.
    expect([...document.querySelectorAll(".ia-acts .ia-opt")].map((b) => b.querySelector("span")!.textContent))
      .toEqual(["Always allow here", "Deny", "Allow"]);
    expect(panes[0].el.querySelector(".ib-pill")!.textContent).toBe("Needs you");
    expect([...panes[0].el.querySelectorAll(".ib-act")].map((b) => b.textContent)).toEqual(["Changes", "History"]);
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

  it("lays every agent of the project out in Split, each answering on its own card", async () => {
    state.tasks = [task("a", "Ana", "needs"), task("e", "Eli", "working")];
    setInbox(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", altKey: true }));
    expect(document.querySelector('[data-dock="split"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll(".split-pin")).toHaveLength(2);
    expect(panes[1].el.style.getPropertyValue("--sw")).not.toBe("");
    // The floating card steps aside; Ana's card carries her question.
    expect((document.querySelector(".inbox-ask") as HTMLElement).hidden).toBe(true);
    expect(panes[0].el.classList.contains("ib-needs")).toBe(true);
    expect(panes[0].el.querySelector(".ib-mini code")!.textContent).toBe("npm run build");
    (panes[0].el.querySelector('.ib-mini [data-n="1"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(state.answered).toEqual([["a", "1"]]);
    expect(panes[0].el.querySelector(".ib-mini")).toBeNull();
    // Clicking into the other terminal makes it the current one.
    panes[1].el.appendChild(document.createElement("textarea")).dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(panes[1].el.classList.contains("focused")).toBe(true);
    // ✕ takes Eli out; with one agent left it is a single stage again.
    (panes[1].el.querySelector('[data-stage="close"]') as HTMLButtonElement).click();
    expect(document.querySelectorAll(".split-pin")).toHaveLength(0);
    expect(panes[0].el.classList.contains("focused")).toBe(true);
    (document.querySelector('[data-dock="queue"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-dock="split"]')!.getAttribute("aria-pressed")).toBe("false");
    expect(panes[0].el.style.getPropertyValue("--sw")).toBe("");
  });

  it("offers Review when an agent is done, and sends it back with feedback", async () => {
    state.tasks = [task("e", "Eli", "review", { changedFiles: 3 })];
    setInbox(true);
    const chip = document.querySelector('.inbox-ask [data-act="review"]') as HTMLButtonElement;
    expect(chip.textContent).toContain("Eli is ready · 3 files changed");
    chip.click();
    expect(state.reviewed).toEqual(["D:/wt/e"]);
    expect(document.querySelector(".inbox-review")!.getAttribute("aria-label")).toBe("Review Eli's changes");
    expect((document.querySelector(".inbox-ask") as HTMLElement).hidden).toBe(true);
    (document.getElementById("irBack") as HTMLInputElement).value = "add a test for the empty case";
    document.querySelector(".ir-back")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(state.texts).toEqual([["e", "add a test for the empty case"]]);
    expect(document.querySelector(".inbox-review")).toBeNull();
  });

  it("filters the queue by project", () => {
    const other = { id: "ws-2", name: "quy", gridEl: document.createElement("div"), panes: new Map() } as unknown as Workspace;
    workspaces.set("ws-2", other);
    document.querySelector(".topbar")!.insertAdjacentHTML("beforeend", '<div class="tb-right"></div>');
    state.tasks = [task("a", "Ana", "needs"), task("q", "Quinn", "working", { wsId: "ws-2", project: "quy" })];
    setInbox(true);
    expect([...document.querySelectorAll(".iq-chip")].map((c) => c.textContent)).toEqual(["All projects · 2", "maestro · 1", "quy · 1"]);
    (document.querySelector('.iq-chip[data-ws="ws-2"]') as HTMLButtonElement).click();
    expect([...document.querySelectorAll(".iq-row")].map((r) => (r as HTMLElement).dataset.id)).toEqual(["q"]);
  });

  it("opens its own palette on Ctrl K with every agent and the actions", () => {
    state.tasks = [task("a", "Ana", "needs"), task("e", "Eli", "working")];
    setInbox(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true }));
    const labels = [...document.querySelectorAll(".pal-it .pal-t")].map((t) => t.firstChild!.textContent);
    expect(labels.slice(0, 3)).toEqual(["Ana", "Eli", "New agent"]);
    expect(labels).toContain("Back to the classic interface");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true }));
    expect(document.querySelector(".inbox-pal")).toBeNull();
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
