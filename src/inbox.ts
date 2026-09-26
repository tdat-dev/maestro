// Agent Inbox interface (preview, behind Settings → "New interface").
//
// It does not rebuild the app: the canvas, panes, PTYs and every existing
// feature stay where they are. With the flag on it adds a Queue down the left
// (every agent in every project, ordered by who needs you), a sentence in the
// top bar that says what needs you, and a decision card that answers an agent's
// prompt with buttons. The "stage" is simply the chosen pane in the canvas's
// existing focus mode, so the terminal is the real xterm you can type into.

import { workspaces, activeWs } from "./appstate";
import { focusPane, renamePane } from "./panelayout";
import { revealPane } from "./agentbridge";
import { tileToFit, type Area, type Tile } from "./canvas";
import { killPty, resizePty, sendInput } from "./ipc";
import { paneFont } from "./zoom";
import { createReviewDrawer } from "./inboxreview";
import { openSettings } from "./settingsmodal";
import { openNewAgent } from "./inboxnew";
import { openPalette, closePalette, paletteOpen, type PaletteItem } from "./inboxpalette";
import { createHistoryDrawer } from "./inboxhistory";
import { mountStart, renderStart, unmountStart } from "./inboxstart";
import { getPref } from "./prefs";
import { activateWorkspace, removeWorkspace, renameWorkspace } from "./workspace";
import { confirmModal } from "./confirmmodal";
import { openMenu, type MenuItem } from "./ctxmenu";
import { openHelpPage, openTool, isHelpKey } from "./inboxhelp";
import { showTip, tipSeen } from "./tips";
import { chatSupported, focusAgent, hideChat, showChat } from "./chatview";
import { topNote } from "./hint";
import { profileOf } from "./cliprofile";
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

/** Where things sit in the list: projects in the order you opened them, agents
 *  in the order they were made. A state change never moves anything. */
export interface ListOrder { ws: Map<string, number>; pane: Map<string, number> }

/** The queue by project, in a fixed order: nothing jumps when an agent's state changes. */
export function projectGroups(list: Task[], order?: ListOrder): Array<{ wsId: string; name: string; tasks: Task[]; needs: number }> {
  const byWs = new Map<string, { wsId: string; name: string; tasks: Task[]; needs: number }>();
  for (const t of list) {
    const g = byWs.get(t.wsId) ?? { wsId: t.wsId, name: t.project, tasks: [], needs: 0 };
    g.tasks.push(t);
    if (t.status.state === "needs") g.needs++;
    byWs.set(t.wsId, g);
  }
  const at = (m: Map<string, number> | undefined, id: string, fallback: number) => m?.get(id) ?? fallback;
  const groups = [...byWs.values()];
  // Unknown ones keep the order they came in, after the known ones.
  for (const g of groups) {
    const was = new Map(g.tasks.map((t, k) => [t.paneId, k]));
    g.tasks.sort((a, b) => at(order?.pane, a.paneId, 1e6 + was.get(a.paneId)!) - at(order?.pane, b.paneId, 1e6 + was.get(b.paneId)!));
  }
  const came = new Map(groups.map((g, k) => [g.wsId, k]));
  return groups.sort((a, b) => at(order?.ws, a.wsId, 1e6 + came.get(a.wsId)!) - at(order?.ws, b.wsId, 1e6 + came.get(b.wsId)!));
}

/** Projects whose agents you folded away in the list, remembered. */
const FOLDED_KEY = "maestro.inbox.folded";
const foldedProjects = new Set<string>((() => {
  try { return JSON.parse(localStorage.getItem(FOLDED_KEY) || "[]") as string[]; } catch { return []; }
})());
function saveFolded(): void {
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...foldedProjects])); } catch { /* storage blocked */ }
}

/** The fixed order of the projects and agents open now. */
export function listOrder(): ListOrder {
  const ws = new Map<string, number>();
  const pane = new Map<string, number>();
  let n = 0;
  [...workspaces.keys()].forEach((id, k) => ws.set(id, k));
  for (const w of workspaces.values()) for (const id of w.panes.keys()) pane.set(id, n++);
  return { ws, pane };
}

/** The top-bar sentence: "2 agents need you. 1 is ready to review, 3 are working." */
export function headline(list: Task[]): { lead: string; rest: string } {
  const n = (s: TaskState) => list.filter((t) => t.status.state === s).length;
  const needs = n("needs"), review = n("review"), working = n("working");
  const are = (k: number) => (k === 1 ? "is" : "are");
  if (!list.length) return { lead: "No agents yet.", rest: " Start one with New agent." };
  const lead = needs ? `${needs} agent${needs === 1 ? " needs" : "s need"} you.` : "Nothing needs you.";
  // Only what is so: the clauses with nobody in them are left out.
  const parts = [
    review ? `${review} ${are(review)} ready to review` : "",
    working ? `${working} ${are(working)} working` : "",
  ].filter(Boolean);
  if (!parts.length) {
    const idle = n("idle"), stopped = n("stopped");
    if (idle) parts.push(`${idle} ${are(idle)} waiting for a task`);
    if (stopped) parts.push(`${stopped} ${are(stopped)} stopped`);
  }
  return { lead, rest: parts.length ? ` ${parts.join(", ")}.` : "" };
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

export const MAX_SPLIT = 9;

/** Pin or unpin an agent for Split. A fifth pin pushes out the oldest one,
 *  never `keep` (the agent on the stage). */
export function togglePin(pins: string[], id: string, keep?: string, max: number = MAX_SPLIT): string[] {
  if (pins.includes(id)) return pins.filter((x) => x !== id);
  const next = [...pins, id];
  while (next.length > max) {
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
 *  up from the queue order to the Split size in Settings, skipping the ones you closed. */
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
/** What the stage says when the shown project has no agents. */
let emptyEl: HTMLElement | null = null;
let timer: number | null = null;
let offTasks: (() => void) | null = null;
/** Prompts the user tucked away ("paneId|prompt"), so they can type in the terminal instead. */
const hidden = new Set<string>();
/** Prompts already answered from a button, until the screen moves on. */
const answered = new Set<string>();
/** Questions already tucked away once because Settings says to start tucked. */
const autoTucked = new Set<string>();
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
/** Agents switched to Terminal on the stage; the rest show as a chat. */
const termMode = new Set<string>();
let chatFor: string | null = null;

/** Whether the stage shows this agent as a conversation. */
function wantsChat(p: Pane): boolean {
  return getPref("chatView") && chatSupported(p) && !termMode.has(p.id);
}

/** The chat view follows the stage: on for the agent there (not in Split),
 *  off for everyone else, so the terminals Split shows are the real ones. */
function renderChat(list: Task[], pane: Pane | undefined): void {
  const on = pane && !splitOn && wantsChat(pane) ? pane : undefined;
  for (const ws of workspaces.values()) for (const p of ws.panes.values()) if (p !== on && p.el.classList.contains("chat-on")) hideChat(p);
  for (const id of borrowed.keys()) { const p = paneById(id); if (p && p !== on && p.el.classList.contains("chat-on")) hideChat(p); }
  if (!on) { chatFor = null; return; }
  const t = list.find((x) => x.paneId === on.id);
  // The full answer card (not the tucked-away chip) is up for this agent: it is
  // the way to reply, and the conversation keeps its end above it.
  const asking = !!askEl && !askEl.hidden && !askEl.classList.contains("min") && (askEl.dataset.key ?? "").startsWith(`${on.id}|`);
  if (asking && askEl) on.el.style.setProperty("--ask-h", `${askEl.offsetHeight + 24}px`);
  showChat(on, { name: on.spec.name, state: t?.status.state ?? "idle", problem: on.error, asking, branch: t?.branch ?? on.spec.branch ?? null, onReview: openReview, onTerminal: () => { termMode.add(on.id); render(); on.term.focus(); } }, chatFor !== on.id);
  chatFor = on.id;
}


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
    if (!pins.includes(pane.id)) pins = togglePin(pins, pane.id, stagePane()?.id, getPref("splitMax"));
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
  if (splitOn) pins = fillPins(pins, allTasks().map((t) => t.paneId), splitClosed, getPref("splitMax"));
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
  if (on && allTasks().length < 2) topNote("The Grid shows agents side by side: start another with <b>New agent</b>");
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
  pins = togglePin(pins, cur.id, cur.id, getPref("splitMax"));
  if (!splitOn) topNote(pins.includes(cur.id) ? `<b>${esc(cur.spec.name)}</b> is in the Grid · <kbd>Alt+S</kbd> shows it` : `<b>${esc(cur.spec.name)}</b> is out of the Grid`);
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
  if (!activeWs) return;
  const cur = stagePane();
  // A pane can come back from Split (or another project) still marked as the
  // stage while its grid never became one; without this it shows as a canvas tile.
  if (cur) {
    if (!activeWs.gridEl.classList.contains("has-focus") && activeWs.panes.has(cur.id)) focusPane(activeWs, cur);
    return;
  }
  // The task list is re-derived on its own tick, so right after a pane goes it
  // can still name it; only a pane that exists can take the stage.
  const inWs = allTasks().filter((t) => t.wsId === activeWs!.id && activeWs!.panes.has(t.paneId));
  const first = (inWs[0] && activeWs.panes.get(inWs[0].paneId)) ?? activeWs.panes.values().next().value;
  if (first) focusPane(activeWs, first);
}

/** What the right-click menu on an agent offers. */
export function agentMenu(t: Task): MenuItem[] {
  const pane = paneOf(t);
  const ws = workspaces.get(t.wsId);
  if (!pane || !ws) return [];
  const pinned = pins.includes(pane.id);
  const branch = pane.spec.branch;
  const click = (sel: string) => pane.el.querySelector<HTMLElement>(sel)?.click();
  const onStage = () => { openTask(t); };
  // Alt+R / Alt+H / Alt+P act on the agent on the stage, so they are only
  // worth showing on that agent's menu.
  const here = stagePane()?.id === pane.id;
  const key = (k: string) => (here ? k : undefined);
  return [
    { label: "Open", run: onStage },
    { label: "Rename…", run: () => void confirmModal({ title: "Rename agent", message: "What should this agent be called?", okLabel: "Rename", input: { value: pane.spec.name } })
      .then((r) => { if (r.ok) { renamePane(pane, r.value); render(); } }) },
    { label: pinned ? "Take out of Grid" : "Add to Grid", hint: key("Alt+P"), run: () => {
      if (pinned) { pins = pins.filter((id) => id !== pane.id); if (splitOn) splitClosed.add(pane.id); }
      else { splitClosed.delete(pane.id); pins = togglePin(pins, pane.id, stagePane()?.id, getPref("splitMax")); if (!splitOn) topNote(`<b>${esc(pane.spec.name)}</b> is in the Grid · <kbd>Alt+S</kbd> shows it`); }
      render();
    } },
    { label: "Changes", hint: key("Alt+R"), sep: true, disabled: !pane.spec.worktree && !pane.spec.cwd, run: () => { onStage(); openReview(); } },
    { label: "History", hint: key("Alt+H"), run: () => { onStage(); openHistory(); } },
    { label: "Copy branch name", disabled: !branch, run: () => { if (branch) void navigator.clipboard?.writeText(branch).catch(() => {}); } },
    // Starts it again in place; a Claude agent carries on its own conversation.
    { label: pane.running ? "Restart" : "Resume", sep: true, run: () => void pane.restart?.() },
    ...(chatSupported(pane) ? [{ label: "New conversation", run: () => void pane.restart?.({ fresh: true }) }] : []),
    { label: "Stop", disabled: !pane.running, run: () => { void killPty(pane.id).catch(() => {}); } },
    { label: "Remove agent…", danger: true, run: () => void confirmModal({
      title: `Remove ${pane.spec.name}?`,
      message: pane.running ? "It stops and its terminal closes. Its branch and the changes on it stay in git." : "Its terminal closes. Its branch and the changes on it stay in git.",
      okLabel: "Remove",
      danger: true,
    }).then((r) => { if (r.ok) click("[data-kill]"); }) },
  ];
}

function renderQueue(list: Task[], current: string | undefined, now: number): void {
  if (!queueEl) return;
  // One group per project, in a fixed order (projects as you opened them,
  // agents as they were made): nothing moves when a state changes. Who needs
  // you is marked where it is, and counted on its project, which folds.
  const groups = projectGroups(list, listOrder());
  const html = `<div class="iq-list">` +
    (groups.length ? groups.map((g, gi) => {
      const folded = foldedProjects.has(g.wsId);
      return `<section class="iq-group${folded ? " folded" : ""}${g.needs ? " has-needs" : ""}">
      <h2 class="iq-gt iq-proj"><button type="button" class="iq-ph" data-proj="${esc(g.wsId)}" aria-expanded="${!folded}" aria-controls="iq-r-${gi}" title="${esc(g.name)}${folded ? " · show its agents" : " · fold"}">
        <svg class="iq-chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2.5 6 5 3.5 7.5" /></svg><span class="iq-pn">${esc(g.name)}</span>${g.needs ? `<span class="iq-need" aria-label="${g.needs} need${g.needs === 1 ? "s" : ""} you">${g.needs}</span>` : ""}<span class="iq-n">${g.tasks.length}</span></button></h2>
      <ul class="iq-rows" id="iq-r-${gi}"${folded ? " hidden" : ""}>${g.tasks.map((t) => {
        const p = paneOf(t);
        const main = t.title ?? t.name;
        const said = rowLine(t);
        // The state in words, unless the line already is the state ("Needs you", "Stopped").
        const state = GROUP_LABEL[t.status.state];
        const line = said === state ? state : `${state} · ${said}`;
        return `<li><button class="iq-row st-${t.status.state}" data-id="${esc(t.paneId)}" aria-current="${t.paneId === current}" aria-haspopup="menu" title="${esc(main)}${t.title ? ` · ${esc(t.name)}` : ""} · ${esc(g.name)} · right-click for more">
          <span class="iq-mk" style="background:${esc(p?.color ?? "var(--muted)")}" aria-hidden="true">${esc((t.name.trim()[0] ?? "?").toUpperCase())}</span>
          <span class="iq-t">${esc(main)}</span>
          <span class="iq-tm">${pins.includes(t.paneId) && splitOn ? `<span class="iq-pin" title="In the Grid">◫</span> ` : ""}<span class="iq-ago" data-since="${t.since}">${ago(now - t.since)}</span></span>
          <span class="iq-more" data-more aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg></span>
          <span class="iq-s">${t.title ? `<span class="iq-p">${esc(t.name)}</span><span class="iq-dot" aria-hidden="true">·</span>` : ""}${t.race ? `<span class="iq-race">race ${t.race.n}/${t.race.of}</span> ` : ""}<span class="iq-l">${esc(line)}</span>${lineCounts(t)}</span>
        </button></li>`;
      }).join("")}</ul>
    </section>`;
    }).join("") : `<p class="iq-empty">No agents yet.</p>`) +
    `</div>`;
  // Rebuilding every second would take the keyboard focus (and a click in
  // progress) away from the list; only a real change rebuilds it.
  const sig = html.replace(/<span class="iq-ago"[^>]*>[^<]*<\/span>/g, "");
  if (sig === queueSig) {
    for (const el of queueEl.querySelectorAll<HTMLElement>(".iq-ago")) el.textContent = ago(now - Number(el.dataset.since));
    return;
  }
  queueSig = sig;
  const had = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".inbox-queue [data-id]");
  const back = had?.dataset.id ? `.iq-row[data-id="${CSS.escape(had.dataset.id)}"]` : null;
  queueEl.innerHTML = html;
  if (back) queueEl.querySelector<HTMLElement>(back)?.focus({ preventScroll: true });
}
let queueSig = "";

function renderHead(list: Task[]): void {
  if (!headEl) return;
  const h = headline(list);
  // A live region: only a real change is worth reading out.
  const html = `<b>${esc(h.lead)}</b>${esc(h.rest)}`;
  if (headEl.innerHTML !== html) headEl.innerHTML = html;
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
    // Grid is terminals only: no Chat/Terminal choice there, even for a lone agent.
    const mode = pinned ? "split" : splitOn ? "grid" : "stage";
    const chatOk = mode === "stage" && chatSupported(p) && getPref("chatView");
    const build = `${mode}|${t.name}|${t.race?.of ?? ""}|${chatOk}`;
    if (!acts || acts.dataset.mode !== build) {
      acts?.remove();
      acts = document.createElement("span");
      acts.className = "ib-acts";
      acts.dataset.mode = build;
      acts.innerHTML = pinned
        ? `<button class="ib-icon" data-stage="full" title="Open full size" aria-label="Open ${esc(t.name)} full size">⤢</button><button class="ib-icon" data-stage="close" title="Take out of Grid" aria-label="Take ${esc(t.name)} out of the Grid">✕</button>`
        : `${chatOk ? `<span class="ib-view" role="group" aria-label="Show ${esc(t.name)} as"><button data-stage="chat" title="The conversation">Chat</button><button data-stage="term" title="The terminal, as the CLI draws it">Terminal</button></span>` : ""}<button class="ib-act ib-term" data-stage="cmds" title="Type / so ${esc(t.name)}'s CLI shows its own commands">Commands</button>${profileOf(p.spec.badge).modelCommand ? `<button class="ib-act ib-term" data-stage="model" title="Open the CLI's own model picker">Model</button>` : ""}<button class="ib-act" data-stage="review" title="What ${esc(t.name)} changed (Alt+R)">Changes</button><button class="ib-act" data-stage="history" title="What ${esc(t.name)} has done (Alt+H)">History</button>${t.race ? `<button class="ib-act" data-stage="compare" title="Everyone on this job, side by side">Compare ${t.race.of}</button>` : ""}`;
      pill.after(acts);
    }
    acts.querySelector('[data-stage="review"]')?.setAttribute("aria-pressed", String(reviewer?.paneId === p.id));
    acts.querySelector('[data-stage="chat"]')?.setAttribute("aria-pressed", String(!termMode.has(p.id)));
    acts.querySelector('[data-stage="term"]')?.setAttribute("aria-pressed", String(termMode.has(p.id)));
    acts.querySelector('[data-stage="history"]')?.setAttribute("aria-pressed", String(historian?.paneId === p.id));
    // Just the branch: the project is already in the queue and the headline.
    // On a Split card the second line is the job, when there is one.
    const where = p.el.querySelector<HTMLElement>("[data-where]");
    if (where) { where.textContent = pinned ? t.title ?? t.branch ?? t.project : t.branch ?? ""; where.title = where.textContent; }
    // On the stage the job is the big line, the agent's name moves up with the CLI.
    let ttl = p.el.querySelector<HTMLElement>(".ib-ttl");
    const showTtl = !pinned && !!t.title;
    p.el.classList.toggle("ib-has-title", showTtl);
    if (!showTtl) ttl?.remove();
    else {
      if (!ttl) {
        ttl = document.createElement("span");
        ttl.className = "ib-ttl";
        ttl.setAttribute("role", "heading");
        ttl.setAttribute("aria-level", "1");
        const nameEl = p.el.querySelector(".pane-bar .pb-name");
        if (nameEl) nameEl.after(ttl); else p.el.querySelector(".pane-bar")?.appendChild(ttl);
      }
      ttl.textContent = t.title!;
      ttl.title = t.title!;
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
  mini.innerHTML = `<p><span class="lb">${esc(lead)}</span>${a.kind !== "question" && a.detail ? `<code title="${esc(a.detail)}">${esc(a.detail)}</code>` : esc(a.prompt)}</p><div class="ib-mini-opts">${btns.join("")}</div>`;
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
  for (const k of autoTucked) if (k !== key) autoTucked.delete(k);
  // Settings → Inbox: start with the small chip instead of the full box.
  if (key && !getPref("askCard") && !autoTucked.has(key)) { autoTucked.add(key); hidden.add(key); }
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
  // Tucked away, the question waits on a chip; in the terminal you can answer it by typing.
  // (whether the chat shows is decided after this card, so ask the same question it does)
  const hideBtn = pane && !splitOn && wantsChat(pane)
    ? `<button class="ia-min" data-act="hide" title="Tuck this away; the chip brings it back">Hide</button>`
    : `<button class="ia-min" data-act="hide" title="Tuck this away and answer by typing in the terminal">Hide · type in terminal</button>`;
  const lead = a.kind === "run" ? `${t.name} wants to run a command` : a.kind === "edit" ? `${t.name} wants to edit a file` : `${t.name} has a question`;
  askEl.dataset.key = key;
  if (isYesNo(a)) {
    // One row, as in the design: say what to do instead on the left, the
    // three choices on the right with Allow last and brightest.
    const order = [...a.options].sort((x, y) => rank(x) - rank(y));
    askEl.innerHTML = `
    <div class="ia-top"><i class="ia-dia" aria-hidden="true"></i><span>${esc(lead)}</span>${a.title ? `<span class="ia-title">${esc(a.title)}</span>` : ""}
      ${hideBtn}</div>
    ${a.detail ? `<p class="ia-why">${esc(a.prompt)}</p><code class="ia-code">${esc(a.detail)}</code>` : `<p class="ia-q">${esc(a.prompt)}</p>`}
    <div class="ia-row">
      <form class="ia-free"><label class="ia-sr" for="iaFree">Tell ${esc(t.name)} what to do instead</label>
        <input id="iaFree" autocomplete="off" placeholder="Or tell ${esc(t.name)} what to do instead…" title="Alt+A to type here"></form>
      <div class="ia-acts">${order.map((o) => `<button class="ia-opt ${o.deny ? "deny" : o.always ? "always" : "allow"}" data-n="${o.n}" title="${esc(o.label)} (Alt+${o.n})">
        <span>${esc(shortLabel(o))}</span><kbd class="ia-k">Alt ${o.n}</kbd></button>`).join("")}</div>
    </div>`;
    return;
  }
  askEl.innerHTML = `
    <div class="ia-top"><i class="ia-dia" aria-hidden="true"></i><span>${esc(lead)}</span>${a.title ? `<span class="ia-title">${esc(a.title)}</span>` : ""}
      ${hideBtn}</div>
    ${a.kind === "question" ? `<p class="ia-q">${esc(a.prompt)}</p>` : a.detail ? `<code class="ia-code">${esc(a.detail)}</code>` : `<p class="ia-q">${esc(a.prompt)}</p>`}
    <div class="ia-opts">${a.options.map((o, i) => `<button class="ia-opt${o.deny ? " deny" : ""}${i === 0 ? " first" : ""}" data-n="${o.n}">
      <span class="ia-k">${o.n}</span><span>${esc(o.label)}</span></button>`).join("")}</div>
    <form class="ia-free"><label class="ia-sr" for="iaFree">Answer ${esc(t.name)} in your own words</label>
      <input id="iaFree" autocomplete="off" placeholder="${a.kind === "question" ? "Something else…" : `Or tell ${esc(t.name)} what to do instead…`}"><button type="submit">Send</button></form>
    <p class="ia-hint">Alt+1…${a.options.length} picks an option · Alt+A types an answer · Alt+↑/↓ moves through the list</p>`;
}

const rank = (o: AskOption) => (o.always ? 0 : o.deny ? 1 : 2);

/** A project with no agents: say so, and offer the one thing to do. */
function renderEmpty(): void {
  if (!emptyEl) return;
  const ws = activeWs;
  const none = !!ws && ws.panes.size === 0;
  emptyEl.hidden = !none;
  if (!none || !ws) return;
  const sig = ws.id + ws.name;
  if (emptyEl.dataset.sig === sig) return;
  emptyEl.dataset.sig = sig;
  emptyEl.innerHTML = `<b>No agents in ${esc(ws.name)} yet</b><span>Say what you want done and one starts on it in this folder.</span>
    <button type="button" class="im-btn primary" data-empty-new>New agent</button>`;
}

/** Tips for what just became useful; showTip keeps them one at a time. */
function teach(list: Task[]): void {
  if (list.length >= 1 && !tipSeen("menu") && !splitOn) { if (showTip("menu")) return; }
  if (list.length >= 2 && !tipSeen("split") && !splitOn) showTip("split");
}

function render(): void {
  if (!document.body.classList.contains("inbox-ui")) return;
  ensureStage();
  layoutSplit();
  const list = allTasks();
  teach(list);
  const pane = stagePane();
  renderQueue(list, pane?.id, Date.now());
  renderHead(list);
  renderHeaders(list, pane);
  renderAsk(list, pane);
  renderChat(list, pane);
  renderEmpty();
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
  if (splitOn) { const a = currentAsk(); if (a) { miniAnswered.set(pane.id, askKey(a)); pane.el.querySelector(".ib-mini")?.remove(); } }
  await answerOption(pane.id, option);
  focusAgent(pane);
}

function currentAsk() {
  const pane = stagePane();
  const t = pane ? allTasks().find((x) => x.paneId === pane.id) : undefined;
  return t?.status.state === "needs" ? t.status.ask : null;
}

function move(delta: number): void {
  // In the order the list shows them: project by project.
  const list = projectGroups(allTasks(), listOrder()).filter((g) => !foldedProjects.has(g.wsId)).flatMap((g) => g.tasks);
  if (!list.length) return;
  const cur = stagePane()?.id;
  const i = list.findIndex((t) => t.paneId === cur);
  const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + delta))];
  if (next) openTask(next);
}

/** A dialog is up (Settings, New agent, Help, the palette, a confirm). */
function dialogOpen(): boolean {
  return !!document.querySelector(".inbox-modal-back, .backdrop.open");
}

function onKey(e: KeyboardEvent): void {
  if (!document.body.classList.contains("inbox-ui") || !e.altKey || e.ctrlKey || e.metaKey) return;
  if (dialogOpen()) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); move(e.key === "ArrowDown" ? 1 : -1); return; }
  const k = e.key.toLowerCase();
  if (k === "s") { e.preventDefault(); setSplit(!splitOn); return; }
  if (k === "p") { e.preventDefault(); pinCurrent(); return; }
  if (k === "r") { e.preventDefault(); if (reviewer?.paneId) reviewer.close(); else openReview(); return; }
  if (k === "h") { e.preventDefault(); if (historian?.paneId) historian.close(); else openHistory(); return; }
  // Alt+A: answer in your own words, from wherever the keyboard is.
  if (k === "a") { const f = askEl?.querySelector<HTMLInputElement>("#iaFree"); if (f) { e.preventDefault(); f.focus(); } return; }
  if (/^[1-9]$/.test(e.key)) {
    const o = currentAsk()?.options.find((x) => x.n === Number(e.key));
    if (o) { e.preventDefault(); e.stopPropagation(); void pick(o); }
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
  const was = document.activeElement as HTMLElement | null;
  const close = () => { back.remove(); if (was?.isConnected) was.focus(); };
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
  const act = (label: string, run: () => void, keys?: string, sub?: string): PaletteItem => ({ group: "Actions", label, run, keys, sub });
  const ws = activeWs;
  const projects: PaletteItem[] = [...workspaces.values()].filter((w) => w !== ws).map((w) => ({
    group: "Projects", label: w.name, sub: `${w.panes.size} agent${w.panes.size === 1 ? "" : "s"}${w.dir ? ` · ${w.dir}` : ""}`,
    run: () => activateWorkspace(w),
  }));
  const here: PaletteItem[] = ws ? [
    { group: "Projects", label: `Rename ${ws.name}`, run: () => void confirmModal({ title: "Rename project", message: "What should this project be called?", okLabel: "Rename", input: { value: ws.name } }).then((r) => { if (r.ok) { renameWorkspace(ws, r.value); render(); } }) },
    { group: "Projects", label: `Close ${ws.name}`, sub: "Stops its agents", run: () => void removeWorkspace(ws) },
  ] : [];
  return [
    ...agents,
    act("New agent", () => openNewAgent(), "Ctrl+Shift+T", "Give 2 or 3 the same job to race them"),
    act(splitOn ? "Back to Focus: one agent, full size" : "Grid: agents side by side", () => setSplit(!splitOn), "Alt+S", splitOn ? undefined : "Each agent on its own card, answering in place"),
    act("Add the current agent to the Grid, or take it out", () => pinCurrent(), "Alt+P"),
    act("Changes of the current agent", () => openReview(), "Alt+R", "Merge them, or send it back with a note"),
    act("History of the current agent", () => openHistory(), "Alt+H", "What it did and what you answered"),
    act("Board", () => openTool("kanban"), "Ctrl+Shift+K", "Cards the agents move as they work"),
    act("Files", () => document.getElementById("btnToggleCode")?.click(), "Ctrl+Shift+E", "Folder tree and editor"),
    act("Settings", () => openSettings(), "Ctrl+,"),
    act("Pomodoro timer", () => openTool("pomodoro"), "Ctrl+Shift+J"),
    act("Flow", () => openTool("flow"), "Ctrl+Shift+M", "Every hand-off between agents"),
    act("Fleet", () => openTool("fleet"), "Ctrl+Shift+L", "Every agent in every project"),
    act("Scheduled agents", () => openTool("schedule"), undefined, "Start a preset at a set time"),
    act("Replays", () => openTool("replays"), undefined, "Watch a recorded session back"),
    act("Usage", () => openTool("usage"), undefined, "Tokens and estimated cost"),
    act("What Maestro can do", () => openHelpPage(), "?", "Every shortcut and hidden feature"),
    ...projects,
    ...here,
  ];
}

/** Ctrl K opens this palette instead of the classic switcher while the new
 *  interface is on. Window capture runs before the switcher's document one. */
function onCtrlK(e: KeyboardEvent): void {
  if (!document.body.classList.contains("inbox-ui")) return;
  // ? or Ctrl+/ shows everything Maestro can do.
  if (isHelpKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); openHelpPage(); return; }
  // Ctrl+, opens Settings, as in most desktop apps.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === ",") { e.preventDefault(); e.stopImmediatePropagation(); openSettings(); return; }
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
    void answerOption(pane.id, o).then(() => focusAgent(pane));
    return;
  }
  const b = target.closest<HTMLElement>("[data-stage]");
  if (!b) return;
  e.stopPropagation();
  switch (b.dataset.stage) {
    case "chat": if (pane) { termMode.delete(pane.id); chatFor = null; render(); } break;
    // The CLI's own menus, typed into its terminal as you would.
    case "cmds": if (pane) { void sendInput(pane.id, "/"); pane.term.focus(); } break;
    case "model": { const c = pane && profileOf(pane.spec.badge).modelCommand; if (pane && c) { void sendInput(pane.id, `${c}\r`); pane.term.focus(); } break; }
    case "term": if (pane) { termMode.add(pane.id); render(); pane.term.focus(); } break;
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

/** The ✕ on an agent's header removes it: ask first, as the menu's Remove does.
 *  The confirmed click is replayed (untrusted), which pane.ts then acts on. */
function onKillClick(e: MouseEvent): void {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-kill]");
  if (!b || !e.isTrusted) return;
  const pane = screenPanes().find((p) => p.el.contains(b));
  if (!pane) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  void confirmModal({
    title: `Remove ${pane.spec.name}?`,
    message: pane.running ? "It stops and its terminal closes. Its branch and the changes on it stay in git." : "Its terminal closes. Its branch and the changes on it stay in git.",
    okLabel: "Remove",
    danger: true,
  }).then((r) => { if (r.ok) b.click(); });
}

const lastState = new Map<string, TaskState>();

/** Settings → Inbox / Review: act on an agent's state changing. Bring an agent
 *  that starts waiting on you onto the stage when the one there is not busy,
 *  and open Changes when the agent on the stage finishes with changes. */
function onStateChanges(list: Task[]): void {
  const stage = stagePane();
  const stageTask = stage && list.find((t) => t.paneId === stage.id);
  const typing = (document.activeElement as HTMLElement | null)?.closest("input, textarea, .inbox-modal, .inbox-pal");
  for (const t of list) {
    const before = lastState.get(t.paneId);
    lastState.set(t.paneId, t.status.state);
    if (before === undefined || before === t.status.state) continue;
    if (t.status.state === "needs" && getPref("jumpToNeeds") && !splitOn && !typing && t.paneId !== stage?.id &&
        (!stageTask || !["needs", "working"].includes(stageTask.status.state))) {
      openTask(t);
      return;
    }
    if (t.status.state === "review" && before === "working" && !tipSeen("review")) showTip("review", `<b>${esc(t.name)}</b> finished. `);
    if (t.status.state === "review" && before === "working" && t.paneId === stage?.id &&
        getPref("reviewOnDone") && !reviewer?.paneId && !splitOn) openReview();
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
  queueSig = ""; // a new, empty list: the first render fills it
  queueEl.setAttribute("aria-label", "Agents");
  app.appendChild(queueEl);
  askEl = document.createElement("section");
  askEl.className = "inbox-ask";
  askEl.hidden = true;
  askEl.setAttribute("aria-live", "polite");
  app.appendChild(askEl);
  emptyEl = document.createElement("section");
  emptyEl.className = "ib-empty";
  emptyEl.hidden = true;
  emptyEl.setAttribute("aria-label", "No agents yet");
  emptyEl.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("[data-empty-new]")) openNewAgent(); });
  app.appendChild(emptyEl);
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
      <button data-dock="queue" aria-pressed="true" title="Focus: one agent at a time, full size (Alt+S switches)"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M5.5 6.5h5M5.5 9.5h3"/></svg><span>Focus</span></button>
      <button data-dock="split" aria-pressed="false" title="Grid: several agents side by side, as terminals (Alt+S switches, Alt+P adds one)"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.4"/><rect x="9" y="2" width="5" height="5" rx="1.4"/><rect x="2" y="9" width="5" height="5" rx="1.4"/><rect x="9" y="9" width="5" height="5" rx="1.4"/></svg><span>Grid</span></button>
    </div>
    <button class="id-search" data-dock="search" title="Jump to an agent or run a command (Ctrl+K)">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      <span>Jump to an agent or run a command</span><kbd>Ctrl+K</kbd></button>
    <button class="id-new" data-dock="new" title="New agent (Ctrl+Shift+T)">New agent</button>
    <button class="id-gear id-help" data-dock="help" aria-label="What Maestro can do" title="What Maestro can do (?)">?</button>
    <button class="id-gear" data-dock="settings" aria-label="Settings" title="Settings (Ctrl+,)">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>`;
  app.appendChild(dockEl);
  splitBtn = dockEl.querySelector<HTMLButtonElement>('[data-dock="split"]');
  dockEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-dock]");
    switch (b?.dataset.dock) {
      case "queue": setSplit(false); break;
      case "split": setSplit(!splitOn); break;
      case "search": openPalette(paletteItems()); break;
      case "new": openNewAgent(); break;
      case "settings": openSettings(); break;
      case "help": openHelpPage(); break;
    }
  });
  document.getElementById("workspaces")?.addEventListener("click", onStageButton);
  document.getElementById("workspaces")?.addEventListener("click", onKillClick, true);
  historian = createHistoryDrawer(app, render);
  reviewer = createReviewDrawer(app, render);

  // Right-click an agent in the queue for everything you can do with it.
  queueEl.addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".iq-row");
    const t = row && allTasks().find((x) => x.paneId === row.dataset.id);
    if (!t) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, agentMenu(t), `${t.name} actions`);
  });
  // Shift+F10 or the menu key opens the same menu on the focused row.
  queueEl.addEventListener("keydown", (e) => {
    if (!(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>(".iq-row");
    const t = row && allTasks().find((x) => x.paneId === row.dataset.id);
    if (!t || !row) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    openMenu(r.left + 24, r.bottom - 4, agentMenu(t), `${t.name} actions`);
  });
  queueEl.addEventListener("click", (e) => {
    // A project's name folds its agents away, or shows them again (remembered).
    const head = (e.target as HTMLElement).closest<HTMLElement>("[data-proj]");
    if (head) {
      const id = head.dataset.proj ?? "";
      if (foldedProjects.has(id)) foldedProjects.delete(id); else foldedProjects.add(id);
      saveFolded();
      render();
      queueEl?.querySelector<HTMLElement>(`[data-proj="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      return;
    }
    const row = (e.target as HTMLElement).closest<HTMLElement>(".iq-row");
    const t = row && allTasks().find((x) => x.paneId === row.dataset.id);
    if (!t || !row) return;
    // The ⋯ on a row opens the same menu as a right-click.
    if ((e.target as HTMLElement).closest("[data-more]")) {
      const r = (e.target as HTMLElement).closest<HTMLElement>("[data-more]")!.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4, agentMenu(t), `${t.name} actions`);
      return;
    }
    openTask(t);
  });
  askEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!b || !askEl) return;
    const key = askEl.dataset.key ?? "";
    if (b.dataset.act === "hide") { hidden.add(key); render(); const p = stagePane(); if (p) focusAgent(p); return; }
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
    void answerText(pane.id, input.value).then(() => focusAgent(pane));
    render();
  });
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", onFocusIn);
  window.addEventListener("keydown", onCtrlK, true);
  window.addEventListener("resize", render);
  // Remember where everyone stands now, so only later changes count.
  for (const t of allTasks()) lastState.set(t.paneId, t.status.state);
  offTasks = onTasksChange(() => { onStateChanges(allTasks()); render(); });
  timer = window.setInterval(render, 1000);
  window.setTimeout(() => showTip("welcome"), 2600);
  render();
}

function unmount(): void {
  document.body.classList.remove("inbox-ui");
  unmountStart();
  if (splitWs) clearSplit(splitWs);
  splitOn = false; pins = []; splitSig = ""; splitWs = null;
  if (reviewer?.paneId) reviewer.close();
  for (const ws of workspaces.values()) for (const p of ws.panes.values()) { p.el.querySelector(".ib-pill")?.remove(); p.el.querySelector(".ib-acts")?.remove(); p.el.querySelector(".ib-mini")?.remove(); p.el.querySelector(".ib-ttl")?.remove(); p.el.classList.remove("ib-needs", "ib-has-title"); }
  queueEl?.remove(); askEl?.remove(); headEl?.remove(); dockEl?.remove(); emptyEl?.remove(); emptyEl = null;
  queueEl = askEl = headEl = dockEl = null; splitBtn = null; reviewer = null; historian = null;
  if (timer !== null) { clearInterval(timer); timer = null; }
  offTasks?.(); offTasks = null;
  document.removeEventListener("keydown", onKey, true);
  document.removeEventListener("focusin", onFocusIn);
  document.getElementById("workspaces")?.removeEventListener("click", onStageButton);
  document.getElementById("workspaces")?.removeEventListener("click", onKillClick, true);
  window.removeEventListener("keydown", onCtrlK, true);
  closePalette();
  window.removeEventListener("resize", render);
  answered.clear(); hidden.clear(); autoTucked.clear(); lastState.clear();
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
