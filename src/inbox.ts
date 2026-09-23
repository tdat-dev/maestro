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
import { mountStart, renderStart, unmountStart } from "./inboxstart";
import { dockToggle } from "./dock";
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

/** "+148 −455" at the end of a row that has changes to review. */
export function lineCounts(t: Pick<Task, "added" | "removed">): string {
  if (t.added == null || t.removed == null || (t.added === 0 && t.removed === 0)) return "";
  return `<span class="iq-ln"><b class="a">+${t.added}</b> <b class="d">−${t.removed}</b></span>`;
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

/** Where each terminal sits in Split: an even grid with a gap. */
export function splitTiles(n: number, area: Area): Tile[] {
  return tileToFit(n, area, { gap: 16, margin: 0, top: 0, bottom: 0 });
}

/** Who is in Split: the agents already there (so nobody jumps around), topped
 *  up from the queue order until there are four, skipping the ones you closed. */
export function fillPins(pins: string[], order: string[], closed: Set<string>, max: number = MAX_SPLIT): string[] {
  const out = pins.filter((id) => order.includes(id) && !closed.has(id));
  for (const id of order) {
    if (out.length >= max) break;
    if (!out.includes(id) && !closed.has(id)) out.push(id);
  }
  return out.slice(-max);
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
/** Agents of other projects shown in Split, with the project they belong to. */
const borrowed = new Map<string, Workspace>();
/** Agents closed out of Split with ✕; they stay out until Split is turned off. */
const splitClosed = new Set<string>();
/** Per-pane answer box in Split: which question it shows, and answered ones. */
const miniAnswered = new Map<string, string>();
let splitBtn: HTMLButtonElement | null = null;
let reviewer: ReturnType<typeof createReviewDrawer> | null = null;
let historian: ReturnType<typeof createHistoryDrawer> | null = null;
let dockEl: HTMLElement | null = null;
/** Queue filter: one project's id, or null for all of them. */
let projectFilter: string | null = null;

function paneOf(t: Task): Pane | undefined {
  return workspaces.get(t.wsId)?.panes.get(t.paneId);
}

function wsOf(id: string): Workspace | undefined {
  for (const ws of workspaces.values()) if (ws.panes.has(id)) return ws;
  return undefined;
}

function paneById(id: string): Pane | undefined {
  return wsOf(id)?.panes.get(id);
}

/** Panes on screen: the shown project's own, plus agents of other projects
 *  that Split has borrowed onto this screen. */
function screenPanes(): Pane[] {
  if (!activeWs) return [];
  const out = [...activeWs.panes.values()];
  for (const id of borrowed.keys()) {
    const p = paneById(id);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The pane on the stage: the focused one on screen. */
function stagePane(): Pane | undefined {
  return screenPanes().find((p) => p.el.classList.contains("focused"));
}

/** Put a task's agent on the stage (switching project if needed). */
export function openTask(t: Task): void {
  const ws = workspaces.get(t.wsId);
  const pane = ws?.panes.get(t.paneId);
  if (!ws || !pane) return;
  // In Split, picking an agent (from any project) adds it next to the others
  // instead of replacing the whole view.
  if (splitOn && stagePane()) {
    splitClosed.delete(pane.id);
    if (!pins.includes(pane.id)) pins = togglePin(pins, pane.id, stagePane()?.id);
    render(); // borrows it onto this screen if it lives in another project
    setCurrent(pane);
    return;
  }
  revealPane(t.wsId, t.paneId);
  focusPane(ws, pane);
  render();
}

/** Make a pane the one the decision card and Alt+number talk to, without
 *  moving or refitting anything (Split keeps every terminal where it is). */
function setCurrent(pane: Pane): void {
  for (const p of screenPanes()) p.el.classList.toggle("focused", p === pane);
  render();
  pane.term.focus();
}

/* ---------------- Split ---------------- */

function refit(pane: Pane, font: number): void {
  pane.term.setFontSize(font);
  const s = pane.term.fit();
  if (pane.running) void resizePty(pane.id, s.cols, s.rows).catch(() => {});
}

const SPLIT_VARS = ["--sx", "--sy", "--sw", "--sh"];

/** Give a borrowed pane back to its own project's canvas. */
function giveBack(id: string): void {
  const home = borrowed.get(id);
  borrowed.delete(id);
  const p = paneById(id);
  if (!home || !p) return;
  p.el.classList.remove("split-pin", "ib-needs");
  for (const v of SPLIT_VARS) p.el.style.removeProperty(v);
  // Its project may already have a pane on its own stage.
  if ([...home.panes.values()].some((x) => x !== p && x.el.classList.contains("focused"))) p.el.classList.remove("focused");
  home.gridEl.appendChild(p.el);
}

function clearSplit(ws: Workspace): void {
  ws.gridEl.classList.remove("inbox-split");
  for (const id of [...borrowed.keys()]) giveBack(id);
  for (const p of ws.panes.values()) {
    if (!p.el.classList.contains("split-pin")) continue;
    p.el.classList.remove("split-pin");
    for (const v of SPLIT_VARS) p.el.style.removeProperty(v);
  }
  const stage = [...ws.panes.values()].find((p) => p.el.classList.contains("focused"));
  requestAnimationFrame(() => { if (stage) refit(stage, paneFont(ws, 2)); });
}

/** Lay the agents in Split out side by side, from every project. Runs on
 *  every render but only touches the DOM (and resizes PTYs) when the set of
 *  panes or the space they share changed. */
function layoutSplit(): void {
  const ws = activeWs;
  if (!ws) return;
  if (splitOn) pins = fillPins(pins, allTasks().map((t) => t.paneId), splitClosed);
  const shown = splitOn ? pins.map(paneById).filter((p): p is Pane => !!p) : [];
  const on = shown.length > 1;
  const area = { width: ws.gridEl.clientWidth, height: ws.gridEl.clientHeight };
  const sig = on ? `${ws.id}|${shown.map((p) => p.id).join(",")}|${area.width}x${area.height}` : "";
  if (sig !== splitSig) {
    splitSig = sig;
    // Leaving Split, or moving to another project, puts the old canvas back.
    if (splitWs && (!on || splitWs !== ws)) clearSplit(splitWs);
    splitWs = on ? ws : null;
    if (on) {
      for (const id of [...borrowed.keys()]) if (!shown.some((p) => p.id === id)) giveBack(id);
      for (const p of shown) {
        if (ws.panes.has(p.id) || borrowed.has(p.id)) continue;
        const home = wsOf(p.id);
        if (!home) continue;
        borrowed.set(p.id, home);
        ws.gridEl.appendChild(p.el);
      }
      ws.gridEl.classList.add("inbox-split", "has-focus");
      const tiles = splitTiles(shown.length, area);
      for (const p of screenPanes()) {
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
  }
  // The agent you talk to must be one of the cards on screen.
  if (on) {
    const cur = stagePane();
    if (!cur || !shown.includes(cur)) for (const p of screenPanes()) p.el.classList.toggle("focused", p === shown[0]);
  }
}

export function setSplit(on: boolean): void {
  splitOn = on;
  if (!on) { splitClosed.clear(); miniAnswered.clear(); }
  splitBtn?.setAttribute("aria-pressed", String(on));
  dockEl?.querySelector('[data-dock="queue"]')?.setAttribute("aria-pressed", String(!on));
  render();
}

/** ✕ on a Split card: take that agent out, hand the focus to another one. */
function closeFromSplit(id: string): void {
  splitClosed.add(id);
  pins = pins.filter((x) => x !== id);
  if (stagePane()?.id === id) {
    const next = pins.map(paneById).find(Boolean);
    if (next) { render(); setCurrent(next); return; }
  }
  render();
}

function pinCurrent(): void {
  const cur = stagePane();
  if (!cur) return;
  pins = togglePin(pins, cur.id, cur.id);
  if (!pins.includes(cur.id) && splitOn) {
    splitClosed.add(cur.id);
    // Taking the agent on the stage out hands the stage to another card.
    const next = pins.map(paneById).find(Boolean);
    if (next) { render(); setCurrent(next); return; }
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
          <span class="iq-t">${esc(t.title ?? t.name)}</span>
          <span class="iq-tm">${pins.includes(t.paneId) && splitOn ? `<span class="iq-pin" title="In Split">◫</span> ` : ""}${ago(now - t.since)}</span>
          <span class="iq-s"><span class="iq-p">${esc(t.title ? t.name : t.project)}</span>${t.race ? ` <span class="iq-race">race ${t.race.n}/${t.race.of}</span>` : ""} · <span class="iq-l">${esc(rowLine(t))}</span>${lineCounts(t)}</span>
        </button>`;
      }).join("") : `<p class="iq-empty">All clear. Nothing is waiting on you.</p>`}
    </section>`).join("") +
    `</div>`;
}

function renderHead(list: Task[]): void {
  if (!headEl) return;
  const h = headline(list);
  headEl.innerHTML = `<b>${esc(h.lead)}</b>${esc(h.rest)}`;
}

/** Headers of the agents on screen: the state pill everywhere; Changes and
 *  History on the stage; open-full-size and close on each Split card, plus
 *  the card's own answer box when that agent needs you. */
function renderHeaders(list: Task[], pane: Pane | undefined): void {
  for (const ws of workspaces.values()) for (const p of ws.panes.values()) {
    const pinned = p.el.classList.contains("split-pin");
    const t = p === pane || pinned ? list.find((x) => x.paneId === p.id) : undefined;
    let pill = p.el.querySelector<HTMLElement>(".ib-pill");
    let acts = p.el.querySelector<HTMLElement>(".ib-acts");
    p.el.classList.toggle("ib-needs", !!t && pinned && t.status.state === "needs");
    if (!t) { pill?.remove(); acts?.remove(); p.el.querySelector(".ib-mini")?.remove(); continue; }
    if (!pill) {
      pill = document.createElement("span");
      p.el.querySelector(".pane-bar .pb-sp")?.after(pill);
    }
    pill.className = `ib-pill st-${t.status.state}`;
    pill.textContent = GROUP_LABEL[t.status.state];
    const mode = pinned ? "split" : "stage";
    if (!acts || acts.dataset.mode !== mode) {
      acts?.remove();
      acts = document.createElement("span");
      acts.className = `ib-acts ${mode}`;
      acts.dataset.mode = mode;
      acts.innerHTML = pinned
        ? `<button class="ib-icon" data-stage="full" title="Open full size" aria-label="Open ${esc(t.name)} full size">⤢</button><button class="ib-icon" data-stage="close" title="Take out of Split" aria-label="Take ${esc(t.name)} out of Split">✕</button>`
        : `<button class="ib-act" data-stage="review" title="What ${esc(t.name)} changed (Alt+R)">Changes</button><button class="ib-act" data-stage="history" title="What ${esc(t.name)} has done (Alt+H)">History</button>${t.race ? `<button class="ib-act" data-stage="compare" title="Everyone on this job, side by side">Compare ${t.race.of}</button>` : ""}`;
      pill.after(acts);
    }
    acts.querySelector('[data-stage="review"]')?.setAttribute("aria-pressed", String(reviewer?.paneId === p.id));
    acts.querySelector('[data-stage="history"]')?.setAttribute("aria-pressed", String(historian?.paneId === p.id));
    // Just the branch: the project is already in the queue and the headline.
    // On a Split card the second line is the job, when there is one.
    const where = p.el.querySelector<HTMLElement>("[data-where]");
    if (where) where.textContent = pinned ? t.title ?? t.branch ?? t.project : t.branch ?? "";
    // On the stage the job is the big line, the agent's name moves up with the CLI.
    let ttl = p.el.querySelector<HTMLElement>(".ib-ttl");
    const showTtl = !pinned && !!t.title;
    p.el.classList.toggle("ib-has-title", showTtl);
    if (!showTtl) ttl?.remove();
    else {
      if (!ttl) {
        ttl = document.createElement("span");
        ttl.className = "ib-ttl";
        p.el.querySelector(".pane-bar")?.appendChild(ttl);
      }
      ttl.textContent = t.title!;
    }
    renderMini(p, t, pinned);
  }
}

const askKey = (a: NonNullable<Task["status"]["ask"]>) => `${a.prompt}|${a.detail ?? ""}|${a.options.map((o) => o.label).join("/")}`;

/** A Split card answers its own agent, right under that agent's terminal. */
function renderMini(p: Pane, t: Task, pinned: boolean): void {
  let mini = p.el.querySelector<HTMLElement>(".ib-mini");
  const a = pinned && t.status.state === "needs" ? t.status.ask : null;
  if (!a) { mini?.remove(); miniAnswered.delete(p.id); return; }
  const key = askKey(a);
  if (miniAnswered.get(p.id) === key) { mini?.remove(); return; }
  if (mini?.dataset.sig === key) return;
  if (!mini) {
    mini = document.createElement("div");
    mini.className = "ib-mini";
    p.el.appendChild(mini);
  }
  mini.dataset.sig = key;
  const btns = isYesNo(a)
    ? [...a.options].sort((x, y) => rank(x) - rank(y)).map((o) =>
        `<button class="ia-opt ${o.deny ? "deny" : o.always ? "always" : "allow"}" data-n="${o.n}" title="${esc(o.label)}">${esc(shortLabel(o))}</button>`)
    : a.options.map((o) => `<button class="ia-opt" data-n="${o.n}">${o.n}. ${esc(o.label)}</button>`);
  const lead = a.kind === "run" ? `${t.name} wants to run` : a.kind === "edit" ? `${t.name} wants to edit` : `${t.name} asks`;
  mini.innerHTML = `<p><span class="lb">${esc(lead)}</span>${a.kind !== "question" && a.detail ? `<code>${esc(a.detail)}</code>` : esc(a.prompt)}</p><div class="ib-mini-opts">${btns.join("")}</div>`;
}

function renderAsk(list: Task[], pane: Pane | undefined): void {
  if (!askEl) return;
  // In Split every card carries its own answer box.
  if (splitSig) { askEl.hidden = true; askEl.innerHTML = ""; askEl.dataset.sig = ""; return; }
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
  renderHeaders(list, pane);
  renderAsk(list, pane);
  renderStart();
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
  render();
}

function openHistory(): void {
  const pane = stagePane();
  if (!pane || !historian) return;
  if (reviewer?.paneId) reviewer.close();
  if (historian?.paneId) historian.close();
  historian.open(pane);
  render();
}

/** Agents racing on one job, in their slot order. */
export function raceOf(list: Task[], id: string): Task[] {
  return list.filter((t) => t.race?.id === id).sort((a, b) => a.race!.n - b.race!.n);
}

/** Compare a race: every agent on the job with how far it got and what it
 *  changed; Review opens that agent's diff, where you merge the one you keep. */
function openCompare(raceId: string): void {
  const racers = raceOf(allTasks(), raceId);
  if (!racers.length) return;
  document.querySelector(".cmp-back")?.remove();
  const back = document.createElement("div");
  back.className = "inbox-modal-back cmp-back";
  back.innerHTML = `<div class="inbox-modal cmp" role="dialog" aria-modal="true" aria-labelledby="cmpTitle">
    <header class="im-head"><div><h2 id="cmpTitle">${esc(racers[0].title ?? "Same job")}</h2><p class="im-sub">${racers.length} agents on the same job. Review each one, merge the best, discard the rest.</p></div>
      <button type="button" class="im-x" data-close aria-label="Close">✕</button></header>
    <div class="cmp-grid">${racers.map((t) => {
      const p = paneOf(t);
      return `<section class="cmp-col">
        <div class="cmp-h"><span class="iq-mk" style="background:${esc(p?.color ?? "#888")}" aria-hidden="true">${esc((t.name.trim()[0] ?? "?").toUpperCase())}</span><b>${esc(t.name)}</b><span class="ib-pill st-${t.status.state}">${GROUP_LABEL[t.status.state]}</span></div>
        <p class="cmp-n">${t.changedFiles == null ? "Changes unknown" : `${t.changedFiles} file${t.changedFiles === 1 ? "" : "s"} changed`}${lineCounts(t)}</p>
        <p class="cmp-l">${esc(rowLine(t))}</p>
        <button class="im-btn${t.status.state === "review" ? " primary" : ""}" data-review="${esc(t.paneId)}">Review</button>
      </section>`;
    }).join("")}</div></div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t === back || t.closest("[data-close]")) { close(); return; }
    const id = t.closest<HTMLElement>("[data-review]")?.dataset.review;
    const task = id && allTasks().find((x) => x.paneId === id);
    if (!task) return;
    close();
    if (splitOn) setSplit(false);
    openTask(task);
    openReview();
  });
  back.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  back.querySelector<HTMLElement>("[data-review]")?.focus();
}

/** Everything Ctrl K can reach: every agent (in queue order), then actions. */
export function paletteItems(): PaletteItem[] {
  const agents: PaletteItem[] = allTasks().map((t) => {
    const p = paneOf(t);
    return {
      group: GROUP_LABEL[t.status.state],
      label: t.name,
      sub: `${t.title ? `${t.title} · ` : ""}${t.project} · ${rowLine(t)}`,
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
    act("Pomodoro timer", () => dockToggle("pomodoro")),
    act("Flow", () => dockToggle("flow")),
    act("Fleet", () => dockToggle("fleet")),
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

function onStageButton(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const paneEl = target.closest<HTMLElement>(".pane");
  const ws = activeWs;
  const pane = ws && paneEl ? screenPanes().find((p) => p.el === paneEl) : undefined;
  const opt = target.closest<HTMLElement>(".ib-mini [data-n]");
  if (opt && pane) {
    e.stopPropagation();
    const a = allTasks().find((x) => x.paneId === pane.id)?.status.ask;
    const o = a?.options.find((x) => x.n === Number(opt.dataset.n));
    if (!a || !o) return;
    miniAnswered.set(pane.id, askKey(a));
    pane.el.querySelector(".ib-mini")?.remove();
    void answerOption(pane.id, o).then(() => pane.term.focus());
    return;
  }
  const b = target.closest<HTMLElement>("[data-stage]");
  if (!b) return;
  e.stopPropagation();
  switch (b.dataset.stage) {
    case "review": if (reviewer?.paneId) reviewer.close(); else openReview(); break;
    case "history": if (historian?.paneId) historian.close(); else openHistory(); break;
    case "compare": { const r = pane && allTasks().find((x) => x.paneId === pane.id)?.race; if (r) openCompare(r.id); break; }
    case "close": if (pane) closeFromSplit(pane.id); break;
    case "full": {
      const t = pane && allTasks().find((x) => x.paneId === pane.id);
      setSplit(false);
      if (t) openTask(t);
      break;
    }
  }
}

/** Clicking into another terminal in Split makes it the current one. */
function onFocusIn(e: FocusEvent): void {
  if (!splitOn || !activeWs) return;
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(".pane.split-pin");
  if (!el || el.classList.contains("focused")) return;
  const pane = screenPanes().find((p) => p.el === el);
  if (pane) setCurrent(pane);
}

function mount(): void {
  const app = document.getElementById("app");
  if (!app || queueEl) return;
  document.body.classList.add("inbox-ui");
  mountStart();
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
  // The floating dock at the bottom: views, the command bar, New agent, tools.
  dockEl = document.createElement("nav");
  dockEl.className = "inbox-dock";
  dockEl.setAttribute("aria-label", "Maestro");
  dockEl.innerHTML = `
    <div class="id-seg">
      <button data-dock="queue" aria-pressed="true" title="One agent at a time">Queue</button>
      <button data-dock="split" aria-pressed="false" title="Pinned agents side by side (Alt+S; Alt+P pins)">Split</button>
    </div>
    <button class="id-search" data-dock="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      <span>Jump to an agent or run a command</span><kbd>Ctrl K</kbd></button>
    <button class="id-new" data-dock="new">New agent</button>`;
  app.appendChild(dockEl);
  splitBtn = dockEl.querySelector<HTMLButtonElement>('[data-dock="split"]');
  dockEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-dock]");
    switch (b?.dataset.dock) {
      case "queue": reviewer?.close(); setSplit(false); break;
      case "split": setSplit(!splitOn); break;
      case "search": openPalette(paletteItems()); break;
      case "new": openNewAgent(); break;
    }
  });
  document.getElementById("workspaces")?.addEventListener("click", onStageButton);
  historian = createHistoryDrawer(app, render);
  reviewer = createReviewDrawer(app, render);

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
  unmountStart();
  if (splitWs) clearSplit(splitWs);
  splitOn = false; pins = []; splitSig = ""; splitWs = null;
  if (reviewer?.paneId) reviewer.close();
  for (const ws of workspaces.values()) for (const p of ws.panes.values()) { p.el.querySelector(".ib-pill")?.remove(); p.el.querySelector(".ib-acts")?.remove(); p.el.querySelector(".ib-mini")?.remove(); p.el.querySelector(".ib-ttl")?.remove(); p.el.classList.remove("ib-needs", "ib-has-title"); }
  queueEl?.remove(); askEl?.remove(); headEl?.remove(); dockEl?.remove();
  queueEl = askEl = headEl = dockEl = null; splitBtn = null; reviewer = null; historian = null;
  projectFilter = null;
  if (timer !== null) { clearInterval(timer); timer = null; }
  offTasks?.(); offTasks = null;
  document.removeEventListener("keydown", onKey, true);
  document.removeEventListener("focusin", onFocusIn);
  document.getElementById("workspaces")?.removeEventListener("click", onStageButton);
  window.removeEventListener("keydown", onCtrlK, true);
  closePalette();
  window.removeEventListener("resize", render);
  answered.clear(); hidden.clear();
}

/** Mount or take down the interface. The app mounts it once at startup
 *  (initInbox); tests use this to start each case clean. */
export function setInbox(on: boolean): void {
  if (on) mount(); else unmount();
}

/** Mount the interface. Call once at startup. */
export function initInbox(): void {
  mount();
}
