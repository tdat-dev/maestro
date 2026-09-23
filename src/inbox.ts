// Agent Inbox interface (preview, behind Settings → "New interface").
//
// It does not rebuild the app: the canvas, panes, PTYs and every existing
// feature stay where they are. With the flag on it adds a Queue down the left
// (every agent in every project, ordered by who needs you), a sentence in the
// top bar that says what needs you, and a decision card that answers an agent's
// prompt with buttons. The "stage" is simply the chosen pane in the canvas's
// existing focus mode, so the terminal is the real xterm you can type into.

import { workspaces, activeWs } from "./appstate";
import { focusPane } from "./panelayout";
import { revealPane } from "./agentbridge";
import { tileToFit, type Area, type Tile } from "./canvas";
import { resizePty } from "./ipc";
import { paneFont } from "./zoom";
import { createReviewDrawer } from "./inboxreview";
import { openSettings } from "./settingsmodal";
import { openNewAgent } from "./inboxnew";
import { openPalette, closePalette, paletteOpen, type PaletteItem } from "./inboxpalette";
import { createHistoryDrawer } from "./inboxhistory";
import { dockToggle } from "./dock";
import { getInboxUi, setInboxUi } from "./settings";
import { allTasks, answerOption, answerText, onTasksChange, type Task } from "./tasks";
import type { AskOption } from "./askparse";
import type { TaskState } from "./taskstate";
import type { Pane, Workspace } from "./panetypes";

/* ---------------- pure helpers (tested) ---------------- */

const ORDER: TaskState[] = ["needs", "review", "working", "idle", "stopped"];
export const GROUP_LABEL: Record<TaskState, string> = {
  needs: "Needs you", review: "Ready to review", working: "Working", idle: "Idle", stopped: "Stopped",
};

/** Tasks grouped in queue order; empty groups dropped except "Needs you",
 *  which stays so an empty inbox can say so. */
export function groupTasks(list: Task[]): Array<{ state: TaskState; tasks: Task[] }> {
  return ORDER.map((state) => ({ state, tasks: list.filter((t) => t.status.state === state) }))
    .filter((g) => g.tasks.length || g.state === "needs");
}

/** The top-bar sentence: "2 agents need you. 1 is ready to review, 3 are working." */
export function headline(list: Task[]): { lead: string; rest: string } {
  const n = (s: TaskState) => list.filter((t) => t.status.state === s).length;
  const needs = n("needs"), review = n("review"), working = n("working");
  const are = (k: number) => (k === 1 ? "is" : "are");
  if (!list.length) return { lead: "No agents yet.", rest: " Start one with New agent." };
  const lead = needs ? `${needs} agent${needs === 1 ? " needs" : "s need"} you.` : "Nothing needs you.";
  return { lead, rest: ` ${review} ${are(review)} ready to review, ${working} ${are(working)} working.` };
}

/** Short second line of a queue row, from the agent's side. */
export function rowLine(t: Task): string {
  const a = t.status.ask;
  switch (t.status.state) {
    case "needs":
      if (!a) return "Needs you";
      if (a.kind === "run") return a.detail ? `Wants to run ${a.detail}` : "Wants to run a command";
      if (a.kind === "edit") return a.detail ? `Wants to edit ${a.detail}` : "Wants to edit a file";
      return `Asks: ${a.prompt}`;
    case "review": return `${t.changedFiles ?? 0} file${t.changedFiles === 1 ? "" : "s"} changed`;
    case "working": return "Working";
    case "stopped": return "Stopped";
    default: return "Waiting for a task";
  }
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/** The short word a permission button wears ("Allow", "Always allow here",
 *  "Deny"); the CLI's full wording stays in the tooltip. */
export function shortLabel(o: AskOption): string {
  if (o.deny) return "Deny";
  if (o.always) return "Always allow here";
  return "Allow";
}

/** Permission prompts (run a command, edit a file) with the usual three
 *  choices get one row of buttons; anything else keeps the numbered list. */
export function isYesNo(a: { kind: string; options: AskOption[] }): boolean {
  return a.kind !== "question" && a.options.length <= 3 &&
    a.options.filter((o) => !o.deny && !o.always).length === 1;
}

export const MAX_SPLIT = 4;

/** Pin or unpin an agent for Split. A fifth pin pushes out the oldest one,
 *  never `keep` (the agent on the stage). */
export function togglePin(pins: string[], id: string, keep?: string): string[] {
  if (pins.includes(id)) return pins.filter((x) => x !== id);
  const next = [...pins, id];
  while (next.length > MAX_SPLIT) {
    const i = next.findIndex((x) => x !== keep && x !== id);
    next.splice(i < 0 ? 0 : i, 1);
  }
  return next;
}

/** Where each pinned terminal sits in Split: an even grid with a gap. */
export function splitTiles(n: number, area: Area): Tile[] {
  return tileToFit(n, area, { gap: 12, margin: 0, top: 0, bottom: 0 });
}

/* ---------------- DOM ---------------- */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let queueEl: HTMLElement | null = null;
let headEl: HTMLElement | null = null;
let askEl: HTMLElement | null = null;
let timer: number | null = null;
let offTasks: (() => void) | null = null;
/** Prompts the user tucked away ("paneId|prompt"), so they can type in the terminal instead. */
const hidden = new Set<string>();
/** Prompts already answered from a button, until the screen moves on. */
const answered = new Set<string>();
/** Split: pinned agents shown side by side as real terminals. Only the pins in
 *  the shown project can be on screen, since each project has its own canvas. */
let splitOn = false;
let pins: string[] = [];
let splitSig = "";
let splitWs: Workspace | null = null;
let splitBtn: HTMLButtonElement | null = null;
let reviewBtn: HTMLButtonElement | null = null;
let reviewer: ReturnType<typeof createReviewDrawer> | null = null;
let historian: ReturnType<typeof createHistoryDrawer> | null = null;
let historyBtn: HTMLButtonElement | null = null;
let dockEl: HTMLElement | null = null;
let statsEl: HTMLElement | null = null;
/** Queue filter: one project's id, or null for all of them. */
let projectFilter: string | null = null;

function paneOf(t: Task): Pane | undefined {
  return workspaces.get(t.wsId)?.panes.get(t.paneId);
}

/** The pane on the stage: the focused pane of the workspace being shown. */
function stagePane(): Pane | undefined {
  if (!activeWs) return undefined;
  return [...activeWs.panes.values()].find((p) => p.el.classList.contains("focused"));
}

/** Put a task's agent on the stage (switching project if needed). */
export function openTask(t: Task): void {
  const ws = workspaces.get(t.wsId);
  const pane = ws?.panes.get(t.paneId);
  if (!ws || !pane) return;
  // In Split, picking an agent of the shown project pins it next to the others
  // instead of replacing the whole view.
  if (splitOn && ws === activeWs && stagePane()) {
    if (!pins.includes(pane.id)) pins = togglePin(pins, pane.id, stagePane()?.id);
    setCurrent(ws, pane);
    return;
  }
  revealPane(t.wsId, t.paneId);
  focusPane(ws, pane);
  render();
}

/** Make a pane the one the decision card and Alt+number talk to, without
 *  moving or refitting anything (Split keeps every terminal where it is). */
function setCurrent(ws: Workspace, pane: Pane): void {
  for (const p of ws.panes.values()) p.el.classList.toggle("focused", p === pane);
  render();
  pane.term.focus();
}

/* ---------------- Split ---------------- */

function refit(pane: Pane, font: number): void {
  pane.term.setFontSize(font);
  const s = pane.term.fit();
  if (pane.running) void resizePty(pane.id, s.cols, s.rows).catch(() => {});
}

function clearSplit(ws: Workspace): void {
  ws.gridEl.classList.remove("inbox-split");
  for (const p of ws.panes.values()) {
    if (!p.el.classList.contains("split-pin")) continue;
    p.el.classList.remove("split-pin");
    for (const v of ["--sx", "--sy", "--sw", "--sh"]) p.el.style.removeProperty(v);
  }
  const stage = [...ws.panes.values()].find((p) => p.el.classList.contains("focused"));
  requestAnimationFrame(() => { if (stage) refit(stage, paneFont(ws, 2)); });
}

/** Lay the pinned terminals of the shown project out side by side. Runs on
 *  every render but only touches the DOM (and resizes PTYs) when the set of
 *  panes or the space they share changed. */
function layoutSplit(): void {
  const ws = activeWs;
  if (!ws) return;
  const stage = stagePane();
  if (splitOn && stage && !pins.includes(stage.id)) pins = togglePin(pins, stage.id, stage.id);
  const shown = pins.map((id) => ws.panes.get(id)).filter((p): p is Pane => !!p);
  const area = { width: ws.gridEl.clientWidth, height: ws.gridEl.clientHeight };
  const on = splitOn && shown.length > 1;
  const sig = on ? `${ws.id}|${shown.map((p) => p.id).join(",")}|${area.width}x${area.height}` : "";
  if (sig === splitSig) return;
  splitSig = sig;
  // Leaving Split, or moving to another project, puts the old canvas back.
  if (splitWs && (!on || splitWs !== ws)) clearSplit(splitWs);
  splitWs = on ? ws : null;
  if (!on) return;
  ws.gridEl.classList.add("inbox-split");
  const tiles = splitTiles(shown.length, area);
  for (const p of ws.panes.values()) {
    const i = shown.indexOf(p);
    p.el.classList.toggle("split-pin", i >= 0);
    if (i < 0) continue;
    const t = tiles[i];
    p.el.style.setProperty("--sx", `${t.x}px`);
    p.el.style.setProperty("--sy", `${t.y}px`);
    p.el.style.setProperty("--sw", `${t.w}px`);
    p.el.style.setProperty("--sh", `${t.h}px`);
  }
  requestAnimationFrame(() => shown.forEach((p) => refit(p, paneFont(ws))));
}

export function setSplit(on: boolean): void {
  splitOn = on;
  splitBtn?.setAttribute("aria-pressed", String(on));
  dockEl?.querySelector('[data-dock="queue"]')?.setAttribute("aria-pressed", String(!on));
  render();
}

function pinCurrent(): void {
  const cur = stagePane();
  if (!cur) return;
  pins = togglePin(pins, cur.id, cur.id);
  if (!pins.includes(cur.id) && splitOn) {
    // Unpinning the agent on the stage hands the stage to another pin.
    const next = pins.map((id) => activeWs?.panes.get(id)).find(Boolean);
    if (next && activeWs) { setCurrent(activeWs, next); return; }
  }
  render();
}

/** Make sure something is on the stage: the first task that needs you in the
 *  shown project, else its first pane. */
function ensureStage(): void {
  if (!activeWs || stagePane()) return;
  const inWs = allTasks().filter((t) => t.wsId === activeWs!.id);
  const first = inWs[0] ? activeWs.panes.get(inWs[0].paneId) : activeWs.panes.values().next().value;
  if (first) focusPane(activeWs, first);
}

function renderQueue(list: Task[], current: string | undefined, now: number): void {
  if (!queueEl) return;
  // Project chips: "All projects · 5", then one per project that has agents.
  const projects = new Map<string, { name: string; n: number }>();
  for (const t of list) {
    const p = projects.get(t.wsId) ?? { name: t.project, n: 0 };
    p.n++;
    projects.set(t.wsId, p);
  }
  if (projectFilter && !projects.has(projectFilter)) projectFilter = null;
  const shown = projectFilter ? list.filter((t) => t.wsId === projectFilter) : list;
  const chip = (id: string, label: string, n: number) =>
    `<button class="iq-chip" data-ws="${esc(id)}" aria-pressed="${(projectFilter ?? "") === id}">${esc(label)} · ${n}</button>`;
  const chips = projects.size > 1
    ? `<div class="iq-chips" role="group" aria-label="Filter by project">${chip("", "All projects", list.length)}${[...projects].map(([id, p]) => chip(id, p.name, p.n)).join("")}</div>`
    : "";
  const groups = groupTasks(shown);
  queueEl.innerHTML = chips +
    `<div class="iq-list" role="list">` +
    groups.map((g) => `<section class="iq-group" aria-label="${GROUP_LABEL[g.state]}">
      <div class="iq-gt"><span>${GROUP_LABEL[g.state]}</span><span class="iq-n">${g.tasks.length}</span></div>
      ${g.tasks.length ? g.tasks.map((t) => {
        const p = paneOf(t);
        return `<button class="iq-row st-${t.status.state}" role="listitem" data-id="${esc(t.paneId)}" aria-current="${t.paneId === current}">
          <span class="iq-mk" style="background:${esc(p?.color ?? "#888")}" aria-hidden="true">${esc((t.name.trim()[0] ?? "?").toUpperCase())}</span>
          <span class="iq-t">${esc(t.name)}</span>
          <span class="iq-tm">${pins.includes(t.paneId) && splitOn ? `<span class="iq-pin" title="In Split">◫</span> ` : ""}${ago(now - t.since)}</span>
          <span class="iq-s"><span class="iq-p">${esc(t.project)}</span> · <span class="iq-l">${esc(rowLine(t))}</span></span>
        </button>`;
      }).join("") : `<p class="iq-empty">All clear. Nothing is waiting on you.</p>`}
    </section>`).join("") +
    `</div>`;
}

function renderHead(list: Task[]): void {
  if (!headEl) return;
  const h = headline(list);
  headEl.innerHTML = `<b>${esc(h.lead)}</b>${esc(h.rest)}`;
  if (statsEl) {
    const projects = new Set(list.map((t) => t.wsId)).size;
    statsEl.textContent = `${list.length} agent${list.length === 1 ? "" : "s"} · ${projects} project${projects === 1 ? "" : "s"}`;
  }
}

/** The state pill in the stage header ("Needs you", "Ready to review", …). */
function renderStagePill(list: Task[], pane: Pane | undefined): void {
  for (const ws of workspaces.values()) for (const p of ws.panes.values()) {
    const onScreen = p === pane || p.el.classList.contains("split-pin");
    const t = onScreen ? list.find((x) => x.paneId === p.id) : undefined;
    let pill = p.el.querySelector<HTMLElement>(".ib-pill");
    if (!t) { pill?.remove(); continue; }
    if (!pill) {
      pill = document.createElement("span");
      p.el.querySelector(".pane-bar .pb-sp")?.after(pill);
    }
    pill.className = `ib-pill st-${t.status.state}`;
    pill.textContent = GROUP_LABEL[t.status.state];
  }
}

function renderAsk(list: Task[], pane: Pane | undefined): void {
  if (!askEl) return;
  const t = pane ? list.find((x) => x.paneId === pane.id) : undefined;
  const a = t?.status.state === "needs" ? t.status.ask : null;
  // The command is part of the identity: Claude asks "Do you want to proceed?"
  // with the same options for every command, and each one is a new question.
  const key = t && a ? `${t.paneId}|${a.prompt}|${a.detail ?? ""}|${a.options.map((o) => o.label).join("/")}` : "";
  // Forget answers and tucked-away cards for questions no longer on screen.
  for (const k of answered) if (k !== key) answered.delete(k);
  for (const k of hidden) if (k !== key) hidden.delete(k);
  // An agent that finished with changes gets a quiet chip that opens Review.
  if (t && t.status.state === "review" && reviewer?.paneId !== t.paneId) {
    const sig = `review|${t.paneId}|${t.changedFiles ?? 0}`;
    if (askEl.dataset.sig === sig && !askEl.hidden) return;
    askEl.dataset.sig = sig;
    askEl.dataset.key = "";
    askEl.hidden = false;
    askEl.className = "inbox-ask min review";
    askEl.innerHTML = `<button class="ia-chip" data-act="review"><i class="ia-dot" aria-hidden="true"></i>${esc(t.name)} is ready · ${esc(rowLine(t))} · Review</button>`;
    return;
  }
  if (!t || !a || answered.has(key)) { askEl.hidden = true; askEl.innerHTML = ""; askEl.dataset.sig = ""; return; }
  // Rebuild only when the question changes: the tick re-renders every second
  // and would otherwise wipe what the user is typing in the answer field.
  const sig = key + (hidden.has(key) ? "|min" : "");
  if (askEl.dataset.sig === sig && !askEl.hidden) return;
  askEl.dataset.sig = sig;
  askEl.hidden = false;
  if (hidden.has(key)) {
    askEl.className = "inbox-ask min";
    askEl.innerHTML = `<button class="ia-chip" data-act="show"><i class="ia-dia" aria-hidden="true"></i>${esc(t.name)} is waiting on you · Show</button>`;
    return;
  }
  askEl.className = "inbox-ask";
  const lead = a.kind === "run" ? `${t.name} wants to run a command` : a.kind === "edit" ? `${t.name} wants to edit a file` : `${t.name} has a question`;
  askEl.dataset.key = key;
  if (isYesNo(a)) {
    // One row, as in the design: say what to do instead on the left, the
    // three choices on the right with Allow last and brightest.
    const order = [...a.options].sort((x, y) => rank(x) - rank(y));
    askEl.innerHTML = `
    <div class="ia-top"><i class="ia-dia" aria-hidden="true"></i><span>${esc(lead)}</span>${a.title ? `<span class="ia-title">${esc(a.title)}</span>` : ""}
      <button class="ia-min" data-act="hide" title="Type in the terminal instead">Hide · type in terminal</button></div>
    ${a.detail ? `<p class="ia-why">${esc(a.prompt)}</p><code class="ia-code">${esc(a.detail)}</code>` : `<p class="ia-q">${esc(a.prompt)}</p>`}
    <div class="ia-row">
      <form class="ia-free"><label class="ia-sr" for="iaFree">Tell ${esc(t.name)} what to do instead</label>
        <input id="iaFree" autocomplete="off" placeholder="Or tell ${esc(t.name)} what to do instead…"></form>
      <div class="ia-acts">${order.map((o) => `<button class="ia-opt ${o.deny ? "deny" : o.always ? "always" : "allow"}" data-n="${o.n}" title="${esc(o.label)} (Alt+${o.n})">
        <span>${esc(shortLabel(o))}</span><kbd class="ia-k">${o.n}</kbd></button>`).join("")}</div>
    </div>`;
    return;
  }
  askEl.innerHTML = `
    <div class="ia-top"><i class="ia-dia" aria-hidden="true"></i><span>${esc(lead)}</span>${a.title ? `<span class="ia-title">${esc(a.title)}</span>` : ""}
      <button class="ia-min" data-act="hide" title="Type in the terminal instead">Hide · type in terminal</button></div>
    ${a.kind === "question" ? `<p class="ia-q">${esc(a.prompt)}</p>` : a.detail ? `<code class="ia-code">${esc(a.detail)}</code>` : `<p class="ia-q">${esc(a.prompt)}</p>`}
    <div class="ia-opts">${a.options.map((o, i) => `<button class="ia-opt${o.deny ? " deny" : ""}${i === 0 ? " first" : ""}" data-n="${o.n}">
      <span class="ia-k">${o.n}</span><span>${esc(o.label)}</span></button>`).join("")}</div>
    <form class="ia-free"><label class="ia-sr" for="iaFree">Answer ${esc(t.name)} in your own words</label>
      <input id="iaFree" autocomplete="off" placeholder="${a.kind === "question" ? "Something else…" : `Or tell ${esc(t.name)} what to do instead…`}"><button type="submit">Send</button></form>
    <p class="ia-hint">Alt+1…${a.options.length} picks an option · Alt+↑/↓ moves through the queue</p>`;
}

const rank = (o: AskOption) => (o.always ? 0 : o.deny ? 1 : 2);

function render(): void {
  if (!document.body.classList.contains("inbox-ui")) return;
  ensureStage();
  layoutSplit();
  const list = allTasks();
  const pane = stagePane();
  renderQueue(list, pane?.id, Date.now());
  renderHead(list);
  renderStagePill(list, pane);
  renderAsk(list, pane);
  // History follows the stage: switch agents and it shows the new one's.
  if (historian?.paneId && pane && historian.paneId !== pane.id) historian.open(pane);
  historian?.refresh();
}

async function pick(option: AskOption): Promise<void> {
  const pane = stagePane();
  const key = askEl?.dataset.key;
  if (!pane) return;
  if (key) answered.add(key);
  render();
  await answerOption(pane.id, option);
  pane.term.focus();
}

function currentAsk() {
  const pane = stagePane();
  const t = pane ? allTasks().find((x) => x.paneId === pane.id) : undefined;
  return t?.status.state === "needs" ? t.status.ask : null;
}

function move(delta: number): void {
  const list = allTasks();
  if (!list.length) return;
  const cur = stagePane()?.id;
  const i = list.findIndex((t) => t.paneId === cur);
  const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + delta))];
  if (next) openTask(next);
}

function onKey(e: KeyboardEvent): void {
  if (!document.body.classList.contains("inbox-ui") || !e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); move(e.key === "ArrowDown" ? 1 : -1); return; }
  const k = e.key.toLowerCase();
  if (k === "s") { e.preventDefault(); setSplit(!splitOn); return; }
  if (k === "p") { e.preventDefault(); pinCurrent(); return; }
  if (k === "r") { e.preventDefault(); if (reviewer?.paneId) reviewer.close(); else openReview(); return; }
  if (k === "h") { e.preventDefault(); if (historian?.paneId) historian.close(); else openHistory(); return; }
  if (/^[1-9]$/.test(e.key)) {
    const o = currentAsk()?.options.find((x) => x.n === Number(e.key));
    if (o) { e.preventDefault(); void pick(o); }
  }
}

function openReview(): void {
  const pane = stagePane();
  if (!pane || !reviewer) return;
  if (historian?.paneId) historian.close();
  reviewer.open(pane);
  reviewBtn?.setAttribute("aria-pressed", "true");
  render();
}

function openHistory(): void {
  const pane = stagePane();
  if (!pane || !historian) return;
  if (reviewer?.paneId) reviewer.close();
  if (historian?.paneId) historian.close();
  historian.open(pane);
  historyBtn?.setAttribute("aria-pressed", "true");
}

/** Everything Ctrl K can reach: every agent (in queue order), then actions. */
export function paletteItems(): PaletteItem[] {
  const agents: PaletteItem[] = allTasks().map((t) => {
    const p = paneOf(t);
    return {
      group: GROUP_LABEL[t.status.state],
      label: t.name,
      sub: `${t.project} · ${rowLine(t)}`,
      mark: { color: p?.color ?? "#888", letter: (t.name.trim()[0] ?? "?").toUpperCase() },
      run: () => openTask(t),
    };
  });
  const act = (label: string, run: () => void, keys?: string): PaletteItem => ({ group: "Actions", label, run, keys });
  return [
    ...agents,
    act("New agent", () => openNewAgent()),
    act(splitOn ? "Leave Split" : "Split: pinned agents side by side", () => setSplit(!splitOn), "Alt+S"),
    act("Pin or unpin the current agent in Split", () => pinCurrent(), "Alt+P"),
    act("Review what the current agent changed", () => openReview(), "Alt+R"),
    act("History of the current agent", () => openHistory(), "Alt+H"),
    act("Board", () => dockToggle("kanban")),
    act("Files", () => document.getElementById("btnToggleCode")?.click(), "Ctrl+Shift+E"),
    act("Settings", () => openSettings()),
    act("Back to the classic interface", () => setInbox(false)),
  ];
}

/** Ctrl K opens this palette instead of the classic switcher while the new
 *  interface is on. Window capture runs before the switcher's document one. */
function onCtrlK(e: KeyboardEvent): void {
  if (!document.body.classList.contains("inbox-ui")) return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (paletteOpen()) closePalette(); else openPalette(paletteItems());
}

/** Clicking into another terminal in Split makes it the current one. */
function onFocusIn(e: FocusEvent): void {
  if (!splitOn || !activeWs) return;
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(".pane.split-pin");
  if (!el || el.classList.contains("focused")) return;
  const pane = [...activeWs.panes.values()].find((p) => p.el === el);
  if (pane) setCurrent(activeWs, pane);
}

function mount(): void {
  const app = document.getElementById("app");
  if (!app || queueEl) return;
  document.body.classList.add("inbox-ui");
  queueEl = document.createElement("aside");
  queueEl.className = "inbox-queue";
  queueEl.setAttribute("aria-label", "Agents");
  app.appendChild(queueEl);
  askEl = document.createElement("section");
  askEl.className = "inbox-ask";
  askEl.hidden = true;
  askEl.setAttribute("aria-live", "polite");
  app.appendChild(askEl);
  headEl = document.createElement("p");
  headEl.className = "inbox-head";
  headEl.setAttribute("aria-live", "polite");
  document.querySelector(".topbar .tb-center")?.prepend(headEl);
  statsEl = document.createElement("span");
  statsEl.className = "inbox-stats";
  document.querySelector(".topbar .tb-right")?.prepend(statsEl);

  // The floating dock at the bottom: views, the command bar, New agent, tools.
  dockEl = document.createElement("nav");
  dockEl.className = "inbox-dock";
  dockEl.setAttribute("aria-label", "Maestro");
  dockEl.innerHTML = `
    <div class="id-seg">
      <button data-dock="queue" aria-pressed="true" title="One agent at a time">Queue</button>
      <button data-dock="split" aria-pressed="false" title="Pinned agents side by side (Alt+S; Alt+P pins)">Split</button>
      <button data-dock="review" aria-pressed="false" title="What the agent on the stage changed (Alt+R)">Review</button>
      <button data-dock="history" aria-pressed="false" title="What the agent on the stage has done (Alt+H)">History</button>
      <button data-dock="board" title="The project's board">Board</button>
    </div>
    <button class="id-search" data-dock="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      <span>Jump to an agent or run a command</span><kbd>Ctrl K</kbd></button>
    <button class="id-new" data-dock="new">New agent</button>
    <div class="id-seg">
      <button data-dock="files" title="Files and editor (Ctrl+Shift+E)">Files</button>
      <button data-dock="settings">Settings</button>
    </div>`;
  app.appendChild(dockEl);
  splitBtn = dockEl.querySelector<HTMLButtonElement>('[data-dock="split"]');
  reviewBtn = dockEl.querySelector<HTMLButtonElement>('[data-dock="review"]');
  historyBtn = dockEl.querySelector<HTMLButtonElement>('[data-dock="history"]');
  dockEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-dock]");
    switch (b?.dataset.dock) {
      case "queue": reviewer?.close(); setSplit(false); break;
      case "split": setSplit(!splitOn); break;
      case "review": if (reviewer?.paneId) reviewer.close(); else openReview(); break;
      case "board": dockToggle("kanban"); break;
      case "history": if (historian?.paneId) historian.close(); else openHistory(); break;
      case "search": openPalette(paletteItems()); break;
      case "new": openNewAgent(); break;
      case "files": document.getElementById("btnToggleCode")?.click(); break;
      case "settings": openSettings(); break;
    }
  });
  historian = createHistoryDrawer(app, () => historyBtn?.setAttribute("aria-pressed", "false"));
  reviewer = createReviewDrawer(app, () => { reviewBtn?.setAttribute("aria-pressed", "false"); render(); });

  queueEl.addEventListener("click", (e) => {
    const chipEl = (e.target as HTMLElement).closest<HTMLElement>(".iq-chip");
    if (chipEl) { projectFilter = chipEl.dataset.ws || null; render(); return; }
    const row = (e.target as HTMLElement).closest<HTMLElement>(".iq-row");
    const t = row && allTasks().find((x) => x.paneId === row.dataset.id);
    if (t) openTask(t);
  });
  askEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!b || !askEl) return;
    const key = askEl.dataset.key ?? "";
    if (b.dataset.act === "hide") { hidden.add(key); render(); stagePane()?.term.focus(); return; }
    if (b.dataset.act === "show") { hidden.clear(); render(); return; }
    if (b.dataset.act === "review") { openReview(); return; }
    const o = currentAsk()?.options.find((x) => x.n === Number(b.dataset.n));
    if (o) void pick(o);
  });
  askEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = askEl?.querySelector<HTMLInputElement>("#iaFree");
    const pane = stagePane();
    if (!input?.value.trim() || !pane) return;
    const key = askEl?.dataset.key;
    if (key) answered.add(key);
    void answerText(pane.id, input.value).then(() => pane.term.focus());
    render();
  });
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", onFocusIn);
  window.addEventListener("keydown", onCtrlK, true);
  window.addEventListener("resize", render);
  offTasks = onTasksChange(render);
  timer = window.setInterval(render, 1000);
  render();
}

function unmount(): void {
  document.body.classList.remove("inbox-ui");
  if (splitWs) clearSplit(splitWs);
  splitOn = false; pins = []; splitSig = ""; splitWs = null;
  if (reviewer?.paneId) reviewer.close();
  for (const ws of workspaces.values()) for (const p of ws.panes.values()) p.el.querySelector(".ib-pill")?.remove();
  queueEl?.remove(); askEl?.remove(); headEl?.remove(); dockEl?.remove(); statsEl?.remove();
  queueEl = askEl = headEl = dockEl = statsEl = null; splitBtn = reviewBtn = historyBtn = null; reviewer = null; historian = null;
  projectFilter = null;
  if (timer !== null) { clearInterval(timer); timer = null; }
  offTasks?.(); offTasks = null;
  document.removeEventListener("keydown", onKey, true);
  document.removeEventListener("focusin", onFocusIn);
  window.removeEventListener("keydown", onCtrlK, true);
  closePalette();
  window.removeEventListener("resize", render);
  answered.clear(); hidden.clear();
}

/** Turn the new interface on or off, and remember the choice. */
export function setInbox(on: boolean): void {
  setInboxUi(on);
  if (on) mount(); else unmount();
}

/** Wire the Settings toggle and restore the saved choice. Call once at startup. */
export function initInbox(): void {
  const toggle = document.getElementById("setInboxUi") as HTMLInputElement | null;
  if (toggle) {
    toggle.checked = getInboxUi();
    toggle.addEventListener("change", () => setInbox(toggle.checked));
  }
  if (getInboxUi()) mount();
}
