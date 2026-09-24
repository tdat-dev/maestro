// "What Maestro can do": every feature that has no button of its own — the
// right-click menus, the keyboard, the terminal's habits and the tools that
// live behind Ctrl K or Settings — on one page. Opens with ? (when you're not
// typing), Ctrl+/, from Ctrl K, and from the start screen. Tools open from it.

import { dockToggle, type ToolId } from "./dock";
import { closePalette } from "./inboxpalette";

export interface HelpRow {
  /** Keys or gesture, each drawn as a key cap ("Alt", "S"); "or" between groups. */
  keys: string[][];
  what: string;
}
export interface HelpSection { title: string; rows: HelpRow[] }
export interface HelpTool { id: string; name: string; what: string; keys?: string[] }

export const HELP: HelpSection[] = [
  { title: "Agents", rows: [
    { keys: [["Right-click"], ["Shift", "F10"]], what: "An agent in the list: rename it, add it to the Grid, see its changes, restart, stop or remove it." },
    { keys: [["Alt", "↑"], ["Alt", "↓"]], what: "Move through the agents in the list." },
    { keys: [["Alt", "1…9"]], what: "Answer the agent on screen with that option, without the mouse." },
    { keys: [["Alt", "A"]], what: "Tell the agent on screen what to do instead, in your own words." },
    { keys: [["Ctrl", "Shift", "T"]], what: "New agent. Give 2 or 3 agents the same job to race them, then Compare and keep the best." },
  ] },
  { title: "Focus, Grid and review", rows: [
    { keys: [["Alt", "S"]], what: "Switch between Focus, one agent as a chat, and Grid, several side by side as terminals, each answering on its own card. Up to 9, in Settings." },
    { keys: [["Alt", "P"]], what: "Add the agent on screen to the Grid, or take it out." },
    { keys: [["Alt", "R"]], what: "What the agent changed, file by file. Merge it, or send it back with a note." },
    { keys: [["Alt", "H"]], what: "What the agent did, and what you answered, by day." },
  ] },
  { title: "Chat", rows: [
    { keys: [["/"]], what: "In an empty message: the agent's own commands, to search and pick. /resume and /clear switch conversations." },
    { keys: [["Esc"]], what: "Stop what the agent is doing." },
    { keys: [["Enter"], ["Shift", "Enter"]], what: "Send, or start a new line." },
  ] },
  { title: "Terminal", rows: [
    { keys: [["Select"]], what: "Selecting text copies it. Right-click a selection to copy it again." },
    { keys: [["Right-click"]], what: "With nothing selected: Paste, Select all, Clear." },
    { keys: [["Drag a file"]], what: "Drop files from Explorer or Files onto an agent to type their paths, in its chat or its terminal." },
    { keys: [["Ctrl", "Shift", "F"]], what: "Find in the output." },
    { keys: [["Ctrl", "wheel"], ["Ctrl", "+ − 0"]], what: "Bigger or smaller text." },
  ] },
  { title: "Anywhere", rows: [
    { keys: [["Ctrl", "K"]], what: "Jump to any agent or project, or run any command." },
    { keys: [["Ctrl", "Tab"]], what: "Next project." },
    { keys: [["Ctrl", "Shift", "E"]], what: "Files: the project's folder tree and editor." },
    { keys: [["Ctrl", ","]], what: "Settings." },
    { keys: [["?"], ["Ctrl", "/"]], what: "This page." },
  ] },
];

export const TOOLS: HelpTool[] = [
  { id: "kanban", name: "Board", what: "Cards the agents move as they plan and finish work.", keys: ["Ctrl", "Shift", "K"] },
  { id: "flow", name: "Flow", what: "Every hand-off between agents, in order, with the message kept.", keys: ["Ctrl", "Shift", "M"] },
  { id: "fleet", name: "Fleet", what: "Every agent in every project at a glance.", keys: ["Ctrl", "Shift", "L"] },
  { id: "pomodoro", name: "Pomodoro", what: "A focus timer while the agents work.", keys: ["Ctrl", "Shift", "J"] },
  { id: "schedule", name: "Scheduled agents", what: "Start a saved preset every day, or once, at a set time." },
  { id: "replays", name: "Replays", what: "Watch a recorded terminal session back." },
  { id: "usage", name: "Usage", what: "Tokens and estimated cost per model, from Claude Code's own logs." },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const caps = (keys: string[]) => keys.map((k) => `<kbd>${esc(k)}</kbd>`).join("");
const combos = (groups: string[][]) => groups.map(caps).join(`<span class="hp-or">or</span>`);

export function helpOpen(): boolean {
  return !!document.querySelector(".hp-back");
}

/** Open the page. `openTool` opens one of TOOLS by id. */
export function openHelp(openTool: (id: string) => void): void {
  if (helpOpen()) return;
  const back = document.createElement("div");
  back.className = "inbox-modal-back hp-back";
  back.innerHTML = `<div class="inbox-modal hp" role="dialog" aria-modal="true" aria-labelledby="hpTitle">
    <header class="im-head"><div><h2 id="hpTitle">What Maestro can do</h2><p class="im-sub">The things without a button of their own. All of them are in Ctrl K too.</p></div>
      <button type="button" class="im-x" data-close aria-label="Close">✕</button></header>
    <div class="hp-body">
      <section class="hp-sec hp-tools" aria-label="Tools"><h3>Tools</h3><div class="hp-grid">${TOOLS.map((t) =>
        `<button type="button" class="hp-tool" data-tool="${esc(t.id)}"><b>${esc(t.name)}</b><span>${esc(t.what)}</span>${t.keys ? `<i>${caps(t.keys)}</i>` : ""}</button>`).join("")}</div></section>
      ${HELP.map((s) => `<section class="hp-sec" aria-label="${esc(s.title)}"><h3>${esc(s.title)}</h3><dl>${s.rows.map((r) =>
        `<div class="hp-row"><dt>${combos(r.keys)}</dt><dd>${esc(r.what)}</dd></div>`).join("")}</dl></section>`).join("")}
    </div></div>`;
  document.body.appendChild(back);
  const prev = document.activeElement as HTMLElement | null;
  const close = () => { back.remove(); prev?.focus?.(); };
  back.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t === back || t.closest("[data-close]")) { close(); return; }
    const id = t.closest<HTMLElement>("[data-tool]")?.dataset.tool;
    if (id) { back.remove(); openTool(id); }
  });
  back.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  back.querySelector<HTMLElement>("[data-close]")?.focus();
}

/** Open a tool from the help page or Ctrl K: the dock panels by id, and the
 *  three that live in Settings through their Settings buttons. */
export function openTool(id: string): void {
  const viaSettings: Record<string, string> = { schedule: "setOpenSched", replays: "setOpenReplays", usage: "setOpenUsage" };
  if (viaSettings[id]) document.getElementById(viaSettings[id])?.click();
  else if (["kanban", "pomodoro", "diff", "fleet", "flow"].includes(id)) dockToggle(id as ToolId);
}

/** The page, from anywhere: the dock's ?, Ctrl K, the start screen. */
export function openHelpPage(): void {
  closePalette();
  openHelp(openTool);
}

/** ? (outside a text field) or Ctrl+/ opens the page. */
export function isHelpKey(e: KeyboardEvent): boolean {
  if (e.altKey || e.metaKey) return false;
  const el = e.target instanceof Element ? e.target : null;
  // A terminal keeps both keys: ? is text and Ctrl+/ is undo in many CLIs.
  if (el?.closest(".xterm")) return false;
  if (e.ctrlKey) return e.key === "/";
  if (e.key !== "?") return false;
  return !el?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}
