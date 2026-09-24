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
  settings: 0,
  killed: [] as string[],
  renamed: [] as Array<[string, string]>,
  confirm: { ok: true, value: "" },
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
    pane.el.parentElement?.classList.add("has-focus");
    state.focused.push(pane.id);
  },
  renamePane: (pane: { id: string; spec: { name: string } }, name: string) => { pane.spec.name = name; state.renamed.push([pane.id, name]); },
}));
vi.mock("./agentbridge", () => ({ revealPane: () => true }));
vi.mock("./zoom", () => ({ paneFont: (_ws: unknown, bump = 0) => 13 + bump }));
vi.mock("./ipc", () => ({ resizePty: async () => {}, killPty: async (id: string) => { state.killed.push(id); } }));
vi.mock("./confirmmodal", () => ({ confirmModal: async () => ({ ok: state.confirm.ok, dontAsk: false, value: state.confirm.value }) }));
vi.mock("./spawnmodal", () => ({ openModal: () => {} }));
vi.mock("./settingsmodal", () => ({ openSettings: () => { state.settings++; } }));
vi.mock("./dock", () => ({ dockToggle: () => {} }));

import { workspaces, setActiveWs } from "./appstate";
import { groupTasks, headline, rowLine, lineCounts, ago, togglePin, splitTiles, fillPins, shortLabel, isYesNo, initInbox, setInbox } from "./inbox";
import type { Workspace, Pane } from "./panetypes";
import { setPref } from "./prefs";

const RUN_ASK: Ask = {
  kind: "run", prompt: "Do you want to proceed?", detail: "npm run build",
  options: [
    { n: 1, label: "Yes", key: "1" },
    { n: 2, label: "Yes, and don't ask again", key: "2", always: true },
    { n: 3, label: "No, and tell Claude what to do differently", key: "\x1b", deny: true },
  ],
};
const task = (paneId: string, name: string, state: Task["status"]["state"], over: Partial<Task> = {}): Task => ({
  paneId, wsId: "ws-1", name, project: "maestro", branch: null, title: null, race: null,
  changedFiles: null, added: null, removed: null, since: 0,
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

  it("pins up to the Split size and never pushes out the one on the stage", () => {
    expect(togglePin(["a", "b"], "b")).toEqual(["a"]);
    expect(togglePin(["a", "b", "c", "d"], "e", "a", 4)).toEqual(["a", "c", "d", "e"]);
    expect(togglePin(["a", "b", "c", "d"], "e", "b", 4)).toEqual(["b", "c", "d", "e"]);
    // up to a 3 x 3 grid
    expect(togglePin(["a", "b", "c", "d", "e"], "f")).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("puts a plain permission prompt on one row with short button words", () => {
    expect(isYesNo(RUN_ASK)).toBe(true);
    expect(RUN_ASK.options.map(shortLabel)).toEqual(["Allow", "Always allow here", "Deny"]);
    expect(isYesNo({ kind: "question", options: RUN_ASK.options })).toBe(false);
  });

  it("fills Split from the queue without moving the agents already there", () => {
    expect(fillPins([], ["a", "b", "c", "d", "e"], new Set(), 4)).toEqual(["a", "b", "c", "d"]);
    expect(fillPins([], ["a", "b", "c", "d", "e", "f", "g"], new Set(), 6)).toEqual(["a", "b", "c", "d", "e", "f"]);
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
`;
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

  it("opens Settings from the gear in the dock and with Ctrl+,", () => {
    state.settings = 0;
    initInbox();
    (document.querySelector('[data-dock="settings"]') as HTMLButtonElement).click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true }));
    expect(state.settings).toBe(2);
  });

  it("offers an agent's actions on right-click and runs them", async () => {
    state.tasks = [task("a", "Ana", "working"), task("e", "Eli", "working")];
    state.killed = []; state.renamed = [];
    (panes[1] as unknown as { running: boolean }).running = true;
    let removed = 0;
    panes[1].el.insertAdjacentHTML("beforeend", '<button data-kill></button><button data-restart></button>');
    panes[1].el.querySelector("[data-kill]")!.addEventListener("click", () => removed++);
    setInbox(true);
    const open = () => document.querySelector('.iq-row[data-id="e"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
    const item = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".cm-item")].find((b) => b.textContent!.startsWith(label))!;
    open();
    expect([...document.querySelectorAll(".cm-item span")].map((x) => x.textContent))
      .toEqual(["Open", "Rename…", "Add to Grid", "Changes", "History", "Copy branch name", "Restart", "Stop", "Remove agent…"]);
    item("Stop").click();
    await Promise.resolve();
    expect(state.killed).toEqual(["e"]);
    expect(document.querySelector(".cm-menu")).toBeNull();
    state.confirm = { ok: true, value: "Zed" };
    open(); item("Rename").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(state.renamed).toEqual([["e", "Zed"]]);
    open(); item("Remove agent").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(removed).toBe(1);
    state.confirm = { ok: false, value: "" };
    open(); item("Remove agent").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(removed).toBe(1);
  });

  it("shows the agent menu from a row's ⋯ and the help page from the dock", () => {
    state.tasks = [task("a", "Ana", "working")];
    setInbox(true);
    (document.querySelector('.iq-row[data-id="a"] [data-more]') as HTMLElement).click();
    expect(document.querySelector(".cm-menu")).not.toBeNull();
    expect(state.focused.filter((x) => x === "a").length).toBeLessThanOrEqual(1); // ⋯ does not also open the agent
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    (document.querySelector('[data-dock="help"]') as HTMLButtonElement).click();
    expect(document.querySelector(".hp-back")).not.toBeNull();
    document.querySelector(".hp-back")!.remove();
  });

  it("mounts at startup", () => {
    initInbox();
    expect(document.body.classList.contains("inbox-ui")).toBe(true);
    expect(document.querySelector(".inbox-queue")).not.toBeNull();
  });

  it("turns a pane still marked as the stage back into the stage when its grid lost it", () => {
    state.tasks = [task("a", "Ana", "working"), task("e", "Eli", "working")];
    // What a pane handed back from Split looks like: marked focused, grid not a stage.
    panes[1].el.classList.add("focused");
    setInbox(true);
    expect(panes[1].el.parentElement!.classList.contains("has-focus")).toBe(true);
    expect(state.focused).toContain("e");
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
    expect([...panes[0].el.querySelectorAll(".ib-act")].map((b) => b.textContent)).toEqual(["Commands", "Changes", "History"]);
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
    expect(labels).toContain("Pomodoro timer");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true }));
    expect(document.querySelector(".inbox-pal")).toBeNull();
  });

  it("titles a row with the job, names the agent under it, tags races and counts lines", () => {
    expect(lineCounts({ added: 148, removed: 455 })).toContain("+148");
    expect(lineCounts({ added: 0, removed: 0 })).toBe("");
    state.tasks = [task("e", "Eli", "review", { title: "Fix the flaky upload test", race: { id: "r", n: 1, of: 3 }, changedFiles: 2, added: 12, removed: 5 })];
    setInbox(true);
    const row = document.querySelector('.iq-row[data-id="e"]')!;
    expect(row.querySelector(".iq-t")!.textContent).toBe("Fix the flaky upload test");
    expect(row.querySelector(".iq-p")!.textContent).toBe("Eli");
    expect(row.querySelector(".iq-race")!.textContent).toBe("race 1/3");
    expect(row.querySelector(".iq-ln")!.textContent).toBe("+12 −5");
    expect(panes[1].el.querySelector(".ib-ttl")!.textContent).toBe("Fix the flaky upload test");
  });

  it("brings agents of other projects into Split and gives them back after", () => {
    const qEl = document.createElement("div");
    qEl.className = "pane";
    qEl.innerHTML = '<div class="pane-bar"><span class="pb-sp"></span><span data-where></span></div>';
    const qGrid = document.createElement("div");
    qGrid.appendChild(qEl);
    const q = { id: "q", el: qEl, color: "#8fb3ff", running: false, spec: { name: "Quinn", cwd: "D:/quy" },
      term: { focus: () => {}, setFontSize: () => {}, fit: () => ({ cols: 80, rows: 24 }) } } as unknown as Pane;
    workspaces.set("ws-2", { id: "ws-2", name: "quy", gridEl: qGrid, panes: new Map([["q", q]]) } as unknown as Workspace);
    state.tasks = [task("a", "Ana", "needs"), task("q", "Quinn", "working", { wsId: "ws-2", project: "quy" })];
    setInbox(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", altKey: true }));
    const grid = panes[0].el.parentElement!;
    expect(qEl.parentElement).toBe(grid);
    expect(qEl.classList.contains("split-pin")).toBe(true);
    // Clicking into Quinn's terminal makes Quinn the current agent.
    qEl.appendChild(document.createElement("textarea")).dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(qEl.classList.contains("focused")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", altKey: true }));
    expect(qEl.parentElement).toBe(qGrid);
    expect(qEl.classList.contains("split-pin")).toBe(false);
  });

  it("compares agents racing on one job and opens the one you pick in Review", () => {
    const race = (n: number) => ({ id: "r1", n, of: 2 });
    state.tasks = [
      task("a", "Ana", "review", { title: "Fix upload", race: race(1), changedFiles: 2, added: 10, removed: 1 }),
      task("e", "Eli", "working", { title: "Fix upload", race: race(2) }),
    ];
    setInbox(true);
    (panes[0].el.querySelector('[data-stage="compare"]') as HTMLButtonElement).click();
    const cols = [...document.querySelectorAll(".cmp-col")];
    expect(cols.map((c) => c.querySelector("b")!.textContent)).toEqual(["Ana", "Eli"]);
    expect(cols[0].querySelector(".cmp-n")!.textContent).toBe("2 files changed+10 −1");
    (cols[1].querySelector("[data-review]") as HTMLButtonElement).click();
    expect(document.querySelector(".cmp-back")).toBeNull();
    expect(state.reviewed).toEqual(["D:/wt/e"]);
  });

  it("starts a prompt as a small chip when Settings says so", () => {
    setPref("askCard", false);
    state.tasks = [task("a", "Ana", "needs")];
    setInbox(true);
    expect(document.querySelector(".inbox-ask .ia-chip")!.textContent).toContain("Ana is waiting on you");
    (document.querySelector(".ia-chip") as HTMLButtonElement).click();
    expect(document.querySelector(".ia-code")!.textContent).toBe("npm run build");
  });

  it("brings up an agent that starts needing you when Settings says so and the stage is quiet", () => {
    setPref("jumpToNeeds", true);
    state.tasks = [task("a", "Ana", "idle"), task("e", "Eli", "working")];
    setInbox(true);
    expect(state.focused[state.focused.length - 1]).toBe("a");
    state.tasks = [task("e", "Eli", "needs"), task("a", "Ana", "idle")];
    state.listeners.forEach((cb) => (cb as (l: Task[]) => void)(state.tasks));
    expect(state.focused[state.focused.length - 1]).toBe("e");
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
