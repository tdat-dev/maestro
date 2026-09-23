// Start screen for the Agent Inbox (the Home page with the new interface on):
// choose a folder or pick a recent project, and see at a glance which of your
// projects have agents waiting on you.

import { workspaces } from "./appstate";
import { activateWorkspace, createWorkspace } from "./workspace";
import { pickFolder } from "./ipc";
import { addRecent, getRecents } from "./recents";
import { allTasks, type Task } from "./tasks";
import { openNewAgent } from "./inboxnew";
import { quickTerminal } from "./spawnmodal";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const FOLDER_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`;

const sameDir = (a: string | null | undefined, b: string) =>
  !!a && a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

/** The last path segment, for a project's name. */
export function folderName(dir: string): string {
  return dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir;
}

/** "4 agents · 1 needs you" for a recent project that is open. */
export function projectLine(dir: string, tasks: Task[]): { agents: number; needs: number } {
  const ws = [...workspaces.values()].find((w) => sameDir(w.dir, dir));
  const mine = ws ? tasks.filter((t) => t.wsId === ws.id) : [];
  return { agents: mine.length, needs: mine.filter((t) => t.status.state === "needs").length };
}

/** Open a folder as a project (or switch to it if it is open), then offer to
 *  start an agent when it has none. */
export function openProject(dir: string, count?: number): void {
  const open = [...workspaces.values()].find((w) => sameDir(w.dir, dir));
  const ws = open ?? createWorkspace(dir);
  if (open) activateWorkspace(open);
  addRecent(dir);
  if (!ws.panes.size || count) openNewAgent({ count });
}

async function chooseFolder(count?: number): Promise<void> {
  const dir = await pickFolder();
  if (dir) openProject(dir, count);
}

let el: HTMLElement | null = null;
let sig = "";

export function renderStart(): void {
  if (!el) return;
  const tasks = allTasks();
  const recents = getRecents();
  const rows = recents.map((dir) => ({ dir, ...projectLine(dir, tasks) }));
  const next = JSON.stringify(rows);
  if (next === sig) return;
  sig = next;
  el.innerHTML = `<div class="st-in">
    <div class="st-brand"><i aria-hidden="true">M</i>Maestro</div>
    <h1><b>Start in a folder.</b> Agents work there, each on its own branch.</h1>
    <p class="st-lede">Pick a project you've used before, or choose a new folder. You can open more than one; the queue shows every project together.</p>
    <div class="st-drop"><span><b>Choose a folder</b>Maestro opens it as a project and asks what the first agent should do.</span>
      <button class="im-btn primary" data-st="choose">Choose folder…</button></div>
    ${rows.length ? `<h2><span>Recent</span><span>${rows.length}</span></h2>
    <div class="st-recent">${rows.map((r) => `<button class="st-rec" data-dir="${esc(r.dir)}">
      <span class="st-ic">${FOLDER_SVG}</span><b>${esc(folderName(r.dir))}</b>
      <span class="st-n">${r.agents ? `${r.agents} agent${r.agents === 1 ? "" : "s"}` : "Not open"}${r.needs ? ` · <span class="needs">${r.needs} need${r.needs === 1 ? "s" : ""} you</span>` : ""}</span>
      <span class="st-p">${esc(r.dir)}</span></button>`).join("")}</div>` : ""}
    <h2><span>Start with</span></h2>
    <div class="st-presets">
      <button class="st-preset" data-st="solo"><b>One agent</b><span>One agent on its own branch. Say what it should do.</span></button>
      <button class="st-preset" data-st="race"><b>Race of three</b><span>Three agents on the same job. Compare their changes and keep the best.</span></button>
      <button class="st-preset" data-st="shell"><b>Plain terminal</b><span>A shell, right now, no agent.</span></button>
    </div>
  </div>`;
}

export function mountStart(): void {
  const home = document.getElementById("home");
  if (!home || el) return;
  el = document.createElement("section");
  el.className = "inbox-start";
  el.setAttribute("aria-label", "Start");
  home.appendChild(el);
  sig = "";
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const rec = t.closest<HTMLElement>(".st-rec");
    if (rec?.dataset.dir) { openProject(rec.dataset.dir); return; }
    switch (t.closest<HTMLElement>("[data-st]")?.dataset.st) {
      case "choose": void chooseFolder(); break;
      case "solo": void chooseFolder(1); break;
      case "race": void chooseFolder(3); break;
      case "shell": quickTerminal(getRecents()[0] ?? null); break;
    }
  });
  renderStart();
}

export function unmountStart(): void {
  el?.remove();
  el = null;
  sig = "";
}
