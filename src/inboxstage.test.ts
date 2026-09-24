// @vitest-environment happy-dom
// The stage with the real pane layout (panelayout.ts is not mocked here): what
// happens to Focus when an agent is restarted, i.e. its pane removed and a new
// one made, the way pane.ts's restart and Resume all do it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "./tasks";

const state = vi.hoisted(() => ({ tasks: [] as Task[], listeners: [] as Array<() => void> }));
vi.mock("./tasks", () => ({
  allTasks: () => state.tasks,
  onTasksChange: (cb: () => void) => { state.listeners.push(cb); return () => {}; },
  answerOption: async () => {},
  answerText: async () => {},
}));
vi.mock("./diffview", () => ({ createDiffView: () => ({ mount: () => {}, setContext: () => {}, show: () => {} }) }));
vi.mock("./agentbridge", () => ({ revealPane: () => true }));
vi.mock("./ipc", () => ({ resizePty: async () => {}, killPty: async () => {}, claudeTranscript: async () => ({ path: "", text: "", next: 0 }), sendMessage: async () => {}, sendInput: async () => {} }));
vi.mock("./spawnmodal", () => ({ openModal: () => {} }));
vi.mock("./settingsmodal", () => ({ openSettings: () => {} }));
vi.mock("./dock", () => ({ dockToggle: () => {} }));

import { workspaces, setActiveWs } from "./appstate";
import { setInbox } from "./inbox";
import { layoutGrid } from "./panelayout";
import type { Workspace, Pane } from "./panetypes";

const task = (paneId: string, name: string, st: Task["status"]["state"]): Task => ({
  paneId, wsId: "ws-1", name, project: "testws", branch: null, title: null, race: null,
  changedFiles: null, added: null, removed: null, since: 0, status: { state: st, ask: null },
});

let ws: Workspace;
function addPane(id: string, name: string): Pane {
  const el = document.createElement("div");
  el.className = "pane";
  el.innerHTML = `<div class="pane-bar"><span class="pb-sp"></span><span data-where></span></div><div class="term-host"></div>`;
  ws.gridEl.appendChild(el);
  const p = {
    id, el, color: "#f2b27a", running: true, spawnedAt: 1,
    spec: { name, badge: "claude", program: "claude", args: [], cwd: "D:/testws", color: "", mono: "", sessionId: "11111111-2222-3333-4444-555555555555" },
    term: { focus: () => {}, setFontSize: () => {}, fit: () => ({ cols: 80, rows: 24 }) },
  } as unknown as Pane;
  ws.panes.set(id, p);
  layoutGrid(ws);
  return p;
}
/** What pane.ts removeAgent does to the page. */
function removePane(id: string): void {
  ws.panes.get(id)!.el.remove();
  ws.panes.delete(id);
  layoutGrid(ws);
}
const tick = () => state.listeners.forEach((cb) => cb());
const focused = () => [...ws.gridEl.querySelectorAll(".pane.focused")].map((e) => [...ws.panes.values()].find((p) => p.el === e)?.spec.name);

describe("stage across a restart", () => {
  beforeEach(() => {
    document.body.className = "";
    document.body.innerHTML = `<div id="app"><header class="topbar"><div class="tb-center"></div></header><main id="workspaces"></main></div>`;
    localStorage.clear();
    state.tasks = []; state.listeners = [];
    const gridEl = document.createElement("div");
    gridEl.className = "grid canvas";
    document.getElementById("workspaces")!.appendChild(gridEl);
    ws = { id: "ws-1", name: "testws", dir: "D:/testws", gridEl, panes: new Map(), layout: new Map() } as unknown as Workspace;
    workspaces.clear(); workspaces.set("ws-1", ws); setActiveWs(ws);
    setInbox(false);
  });

  it("keeps one agent on the stage when the one there is restarted", () => {
    addPane("a1", "Ana"); addPane("b", "Bob"); addPane("c", "Cid");
    state.tasks = [task("a1", "Ana", "stopped"), task("b", "Bob", "stopped"), task("c", "Cid", "stopped")];
    setInbox(true);
    expect(focused()).toEqual(["Ana"]);
    expect(ws.gridEl.classList.contains("has-focus")).toBe(true);

    // Start again: the old pane goes, a new one comes, the tasks catch up.
    removePane("a1");
    const a2 = addPane("a2", "Ana");
    state.tasks = [task("a2", "Ana", "needs"), task("b", "Bob", "stopped"), task("c", "Cid", "stopped")];
    tick();
    expect(ws.gridEl.classList.contains("has-focus")).toBe(true);
    expect(focused()).toEqual(["Ana"]);
    expect(a2.el.classList.contains("focused")).toBe(true);
  });
});
