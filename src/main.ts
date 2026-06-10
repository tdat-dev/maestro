// Styles are loaded via a render-blocking <link> in index.html (not imported
// here) so the first paint is fully styled — see the note in index.html.
import { mountTerminal, type TerminalHandle } from "./terminal";
import {
  spawnPty,
  attachPty,
  sendInput,
  resizePty,
  killPty,
  killAll,
  onExit,
  pickFolder,
  onWindowClose,
  confirmDialog,
  destroyWindow,
  setTrayVisible,
  setTrayTooltip,
  onTrayQuit,
  gitRepoRoot,
  worktreeAdd,
  onDragDrop,
  openDetachWindow,
  broadcastQuit,
  onAppQuit,
} from "./ipc";
import { branchName } from "./worktree";
import {
  getHideToTray,
  setHideToTray,
  getMascotMode,
  setMascotMode,
  getMascotPos,
  setMascotPos,
  type MascotMode,
} from "./settings";
import { CLI_PRESETS, expandCrew, runLimited, launchSpec, effectiveArgs, type CrewState, type CliPreset } from "./crew";
import { basename, nextWorkspaceName, pickNextActive, needsCloseConfirm } from "./workspaces";
import { checkForUpdates } from "./updater";
import { getVersion } from "@tauri-apps/api/app";
import { initTitlebar } from "./titlebar";
import { initIdleAnimationPause } from "./power";
import { CLI_LOGOS } from "./logos";
import { initAiCode, setActiveDirProvider } from "./aicode";
import { Mascot } from "./mascot";

/* Home launcher ⇄ Workspace grid.
 * Home is shown while there are 0 agents (the prominent "create" entry).
 * Spawning agents switches to the Workspace; closing them all returns Home.
 * Each agent = its own real ConPTY process; closing a pane tree-kills it. */

interface Pane {
  id: string;
  el: HTMLElement;
  term: TerminalHandle;
  running: boolean;
  spawnedAt: number | null;
  lastOutputAt: number; // ms of the last PTY output — drives the active/idle status
  color: string;
  spec: AgentSpec; // the launch recipe — kept so the session can be serialized + re-booted
}

// No PTY output for this long while alive ⇒ the agent is idle (waiting at a prompt).
const IDLE_MS = 1200;

// Per-CLI identity color for the monogram tile (brand-adjacent, distinct on dark).
const CLI_COLORS: Record<string, string> = {
  claude: "#d97757",
  codex: "#10a37f",
  gemini: "#4f8cf7",
  aider: "#c6f135",
  cursor: "#e8edf2",
  opencode: "#f0883e",
  qwen: "#a855f7",
  copilot: "#9aa4b2",
  goose: "#f6c453",
  shell: "#5ec2f0",
  cmd: "#94a3b1",
  custom: "#c6f135",
};
function cliLook(badge: string, label: string): { color: string; mono: string } {
  return { color: CLI_COLORS[badge] ?? "#c6f135", mono: (label.trim()[0] ?? "?").toUpperCase() };
}
function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  return h > 0 ? `${h}:${p(m % 60)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

// Each tab is a Workspace: its own grid of panes. Only the active one is shown.
interface Workspace {
  id: string;
  name: string;
  dir: string | null;
  repoRoot: string | null;   // git repo root when isolated; else null
  isolated: boolean;         // create a worktree per agent
  gridEl: HTMLElement;
  tabEl: HTMLElement;
  panes: Map<string, Pane>;
}
const workspaces = new Map<string, Workspace>();
let activeWs: Workspace | null = null;
let wsCounter = 0;
let counter = 0;
const enc = new TextEncoder();

// A detached window (a tab dragged out of another Maestro window) boots with
// ?detach=<key> pointing at its localStorage hand-off payload. It skips the
// main window's app-global duties (kill-all, session restore, tray, updates).
const DETACH_KEY = new URLSearchParams(location.search).get("detach");
const isDetachedWindow = DETACH_KEY !== null;

const homeEl = document.getElementById("home") as HTMLElement;
const appEl = document.getElementById("app") as HTMLElement;
const wsHost = document.getElementById("workspaces") as HTMLElement;
const tabstrip = document.getElementById("tabstrip") as HTMLElement;
const tabAdd = document.getElementById("tabAdd") as HTMLElement;

function showWorkspace() {
  homeEl.hidden = true;
  appEl.hidden = false;
}
function showView() {
  if (workspaces.size > 0) showWorkspace();
  else {
    appEl.hidden = true;
    homeEl.hidden = false;
  }
  syncResume();
}
/** Sync the "Back to workspace" affordance shown on Home when tabs are alive. */
function syncResume() {
  const bar = document.getElementById("homeResume");
  if (!bar) return;
  bar.hidden = workspaces.size === 0;
  const c = document.getElementById("homeResumeCount");
  if (c) c.textContent = workspaces.size ? `${workspaces.size} workspace${workspaces.size > 1 ? "s" : ""}` : "";
}
/** Go to the launcher without killing any tabs (agents keep running). */
function goHome() {
  homeEl.hidden = false;
  appEl.hidden = true;
  syncResume();
}
function resumeWorkspace() {
  if (workspaces.size > 0) {
    homeEl.hidden = true;
    appEl.hidden = false;
  }
}

const SPAWN_TILE_SVG =
  '<span class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span><span class="t">Spawn agent</span><span class="sub">real ConPTY · type · tree-kill</span>';

function createWorkspace(dir: string | null, name?: string): Workspace {
  wsCounter += 1;
  const id = `ws-${wsCounter}`;
  // A restored tab passes its original name; otherwise auto-name it.
  const wsName = name ?? nextWorkspaceName(dir, [...workspaces.values()].map((w) => w.name));

  const gridEl = document.createElement("div");
  gridEl.className = "grid";
  const tile = document.createElement("button");
  tile.className = "tile-spawn";
  tile.innerHTML = SPAWN_TILE_SVG;
  tile.addEventListener("click", () => openModal("current"));
  gridEl.appendChild(tile);
  wsHost.appendChild(gridEl);

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.innerHTML =
    `<span class="tdot"></span><span class="tname"></span><span class="tcount"></span>` +
    `<button class="tclose" aria-label="Close workspace">${KILL_SVG}</button>`;
  tabEl.querySelector(".tname")!.textContent = wsName;
  tabEl.dataset.ws = id;
  tabstrip.insertBefore(tabEl, tabAdd);

  const ws: Workspace = { id, name: wsName, dir, repoRoot: null, isolated: false, gridEl, tabEl, panes: new Map() };
  tabEl.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".tclose")) return;
    activateWorkspace(ws);
  });
  tabEl.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest(".tclose")) return;
    startTabRename(ws);
  });
  tabEl.querySelector(".tclose")!.addEventListener("click", (e) => {
    e.stopPropagation();
    void removeWorkspace(ws);
  });
  wireTabDrag(ws);

  workspaces.set(id, ws);
  activateWorkspace(ws);
  layoutGrid(ws);
  saveSession();
  return ws;
}

function activateWorkspace(ws: Workspace) {
  activeWs = ws;
  for (const w of workspaces.values()) {
    w.gridEl.hidden = w !== ws;
    w.tabEl.classList.toggle("active", w === ws);
  }
  showWorkspace();
  updateBcast();
}

/** Tile a workspace's panes to fill the whole area (1→full, 2→split, 4→2×2, …).
 *  The spawn tile only appears when the workspace is empty. */
function layoutGrid(ws: Workspace) {
  const n = ws.panes.size;
  const tile = ws.gridEl.querySelector<HTMLElement>(".tile-spawn");
  if (tile) tile.style.display = n > 0 ? "none" : "";
  const cols = n <= 1 ? 1 : Math.ceil(Math.sqrt(n));
  const rows = Math.max(1, Math.ceil(Math.max(n, 1) / cols));
  ws.gridEl.style.setProperty("--cols", String(cols));
  ws.gridEl.style.setProperty("--rows", String(rows));
  // Stretch the last pane across any trailing empty cells so the grid fully fills.
  const panes = [...ws.panes.values()];
  panes.forEach((p) => (p.el.style.gridColumn = ""));
  if (n > 0 && n % cols !== 0) {
    panes[panes.length - 1].el.style.gridColumn = `span ${cols - (n % cols) + 1}`;
  }
}

/* ---------------- pane focus / maximize ---------------- */
// Blow one pane up to fill the whole workspace (others hidden); toggle off to
// restore the grid. Only one pane is maximized at a time. Triggered by the ⤢
// button or a double-click on the pane header.
function toggleMax(ws: Workspace, pane: Pane) {
  const willMax = !pane.el.classList.contains("maxed");
  for (const p of ws.panes.values()) {
    const on = p === pane && willMax;
    p.el.classList.toggle("maxed", on);
    const b = p.el.querySelector<HTMLElement>("[data-max]");
    if (b) {
      b.innerHTML = on ? MIN_SVG : MAX_SVG;
      b.setAttribute("aria-label", on ? "Restore pane" : "Maximize pane");
    }
  }
  ws.gridEl.classList.toggle("has-max", willMax);
  // The visible cell(s) resized → re-fit every terminal and correct PTY sizes.
  requestAnimationFrame(() => {
    for (const p of ws.panes.values()) {
      const s = p.term.fit();
      if (p.running) void resizePty(p.id, s.cols, s.rows).catch(() => {});
    }
    if (willMax) pane.term.focus();
  });
}

/* ---------------- pane search (find in output) ---------------- */
function wirePaneSearch(pane: Pane) {
  const el = pane.el;
  const bar = el.querySelector<HTMLElement>("[data-find]");
  const input = el.querySelector<HTMLInputElement>("[data-find-in]");
  const count = el.querySelector<HTMLElement>("[data-find-count]");
  if (!bar || !input) return;
  const open = () => {
    bar.hidden = false;
    input.focus();
    input.select();
    if (input.value) pane.term.findNext(input.value);
  };
  const close = () => {
    bar.hidden = true;
    pane.term.clearSearch();
    if (count) count.textContent = "";
    pane.term.focus();
  };
  pane.term.onSearchResults((cur, total) => {
    if (count) count.textContent = total ? `${cur}/${total}` : input.value ? "0/0" : "";
  });
  el.querySelector("[data-search]")?.addEventListener("click", () => (bar.hidden ? open() : close()));
  el.querySelector("[data-find-close]")?.addEventListener("click", close);
  el.querySelector("[data-find-next]")?.addEventListener("click", () => pane.term.findNext(input.value));
  el.querySelector("[data-find-prev]")?.addEventListener("click", () => pane.term.findPrev(input.value));
  input.addEventListener("input", () => pane.term.findNext(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) pane.term.findPrev(input.value);
      else pane.term.findNext(input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
}

/* ---------------- pane drag-reorder ---------------- */
// Header is the drag handle; dropping over another pane live-reorders the DOM,
// and the new order is committed back into ws.panes (+ persisted) on dragend.
let dragSrc: { ws: Workspace; id: string } | null = null;
function wirePaneDrag(ws: Workspace, pane: Pane) {
  const el = pane.el;
  const head = el.querySelector<HTMLElement>("[data-drag]");
  if (!head) return;
  head.setAttribute("draggable", "true");
  head.addEventListener("dragstart", (e) => {
    if ((e.target as HTMLElement).closest(".pctrl")) {
      e.preventDefault(); // buttons aren't drag handles
      return;
    }
    dragSrc = { ws, id: pane.id };
    el.classList.add("dragging");
    ws.gridEl.classList.add("reordering");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", pane.id);
    }
  });
  head.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    ws.gridEl.classList.remove("reordering");
    dragSrc = null;
    commitPaneOrder(ws);
  });
  el.addEventListener("dragover", (e) => {
    if (!dragSrc || dragSrc.ws !== ws || dragSrc.id === pane.id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const src = ws.panes.get(dragSrc.id);
    if (!src) return;
    const r = el.getBoundingClientRect();
    // anti-diagonal split → upper-left half drops before this pane, else after
    const before = (e.clientY - r.top) / r.height + (e.clientX - r.left) / r.width < 1;
    ws.gridEl.insertBefore(src.el, before ? el : el.nextSibling);
  });
  el.addEventListener("drop", (e) => e.preventDefault());
}

// Rebuild ws.panes to match the current DOM order, then re-tile + persist.
function commitPaneOrder(ws: Workspace) {
  const next = new Map<string, Pane>();
  ws.gridEl.querySelectorAll<HTMLElement>(".pane").forEach((p) => {
    const id = p.dataset.id;
    const existing = id ? ws.panes.get(id) : undefined;
    if (id && existing) next.set(id, existing);
  });
  for (const [k, v] of ws.panes) if (!next.has(k)) next.set(k, v); // safety net
  ws.panes = next;
  layoutGrid(ws);
  saveSession();
}

/* ---------------- tab drag (reorder / detach) + rename ---------------- */
// The whole tab is the drag handle. Dragging over a sibling live-reorders the
// strip (committed + persisted on dragend); releasing OUTSIDE the window
// detaches the workspace into a brand-new Maestro window (agents keep running).
let tabDragSrc: Workspace | null = null;
// Whether the drag pointer is currently over THIS window. dragend's
// coordinates alone are unreliable for out-of-window drops in WebView2, so we
// also track window enter/leave during the drag (leave → relatedTarget null).
let tabDragInside = true;
document.addEventListener("dragenter", () => {
  if (tabDragSrc) tabDragInside = true;
});
document.addEventListener("dragleave", (e) => {
  if (tabDragSrc && e.relatedTarget === null) tabDragInside = false;
});
function wireTabDrag(ws: Workspace) {
  const el = ws.tabEl;
  el.setAttribute("draggable", "true");
  el.addEventListener("dragstart", (e) => {
    // No dragging from the ✕ button or while the name is being edited.
    if ((e.target as HTMLElement).closest(".tclose") || el.querySelector(".tname-edit")) {
      e.preventDefault();
      return;
    }
    tabDragSrc = ws;
    tabDragInside = true;
    el.classList.add("dragging");
    tabstrip.classList.add("reordering");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", ws.id);
    }
  });
  el.addEventListener("dragend", (e) => {
    el.classList.remove("dragging");
    tabstrip.classList.remove("reordering");
    const src = tabDragSrc;
    tabDragSrc = null;
    if (!src || !workspaces.has(src.id)) return;
    // Released beyond the viewport → tear the tab out into its own window.
    const out =
      !tabDragInside ||
      e.clientX < 0 ||
      e.clientY < 0 ||
      e.clientX > window.innerWidth ||
      e.clientY > window.innerHeight;
    if (out) void detachWorkspace(src);
    else commitTabOrder();
  });
  el.addEventListener("dragover", (e) => {
    if (!tabDragSrc || tabDragSrc === ws) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const r = el.getBoundingClientRect();
    const before = e.clientX - r.left < r.width / 2; // left half → drop before
    tabstrip.insertBefore(tabDragSrc.tabEl, before ? el : el.nextSibling);
  });
  el.addEventListener("drop", (e) => e.preventDefault());
}

// Rebuild the workspaces Map to match the tabstrip's DOM order, then persist —
// session save iterates the Map, so the order survives restarts.
function commitTabOrder() {
  const ordered: Workspace[] = [];
  tabstrip.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
    const w = t.dataset.ws ? workspaces.get(t.dataset.ws) : undefined;
    if (w) ordered.push(w);
  });
  for (const w of workspaces.values()) if (!ordered.includes(w)) ordered.push(w); // safety net
  workspaces.clear();
  for (const w of ordered) workspaces.set(w.id, w);
  saveSession();
}

/** Double-click rename: swap the tab label for an inline input. Enter/blur
 *  commits, Escape cancels. Dragging is suppressed while editing. */
function startTabRename(ws: Workspace) {
  const nameEl = ws.tabEl.querySelector<HTMLElement>(".tname");
  if (!nameEl || nameEl.querySelector(".tname-edit")) return;
  const input = document.createElement("input");
  input.className = "tname-edit";
  input.value = ws.name;
  input.spellcheck = false;
  nameEl.replaceChildren(input);
  ws.tabEl.setAttribute("draggable", "false");
  input.focus();
  input.select();
  let cancelled = false;
  const done = () => {
    const v = input.value.trim();
    if (!cancelled && v) {
      ws.name = v;
      saveSession();
    }
    nameEl.replaceChildren();
    nameEl.textContent = ws.name;
    ws.tabEl.setAttribute("draggable", "true");
  };
  input.addEventListener("blur", done);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep workspace-level shortcuts out of the editor
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
      cancelled = true;
      input.blur();
    }
  });
  // The tab's click/dblclick handlers shouldn't re-fire while editing.
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
}

/* ---------------- tab detach → new Maestro window ---------------- */

// Hand-off payload written to localStorage (shared across this app's windows)
// and consumed once by the new window's boot path.
interface DetachAgent {
  spec: AgentSpec;
  id: string;
  running: boolean;
  spawnedAt: number | null;
}
interface DetachPayload {
  name: string;
  dir: string | null;
  repoRoot: string | null;
  isolated: boolean;
  agents: DetachAgent[];
}

/** Move `ws` into a brand-new Maestro window. Running agents are NOT killed:
 *  the new window re-attaches to their PTYs (`pty_attach`) and the backend
 *  replays the recent scrollback. This window just drops its tab. */
async function detachWorkspace(ws: Workspace) {
  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const payload: DetachPayload = {
    name: ws.name,
    dir: ws.dir,
    repoRoot: ws.repoRoot,
    isolated: ws.isolated,
    agents: [...ws.panes.values()].map((p) => ({
      spec: p.spec,
      id: p.id,
      running: p.running,
      spawnedAt: p.spawnedAt,
    })),
  };
  try {
    localStorage.setItem(`maestro.detach.${key}`, JSON.stringify(payload));
  } catch {
    return; // storage unavailable — keep the tab here rather than lose it
  }
  try {
    await openDetachWindow(key, `Maestro — ${ws.name}`);
  } catch (e) {
    localStorage.removeItem(`maestro.detach.${key}`);
    console.warn("detach window failed:", e);
    return;
  }
  // Hand-off succeeded: drop the tab locally WITHOUT killing its PTYs. Their
  // output keeps flowing into the backend scrollback buffer until the new
  // window attaches.
  for (const p of ws.panes.values()) {
    p.term.dispose();
    p.el.remove();
  }
  ws.panes.clear();
  dropWorkspace(ws);
}

/** Remove a (already emptied) workspace's DOM + map entry and refocus. Shared
 *  by close (panes killed first) and detach (panes handed off first). */
function dropWorkspace(ws: Workspace) {
  const nextId = pickNextActive([...workspaces.keys()], ws.id);
  ws.gridEl.remove();
  ws.tabEl.remove();
  workspaces.delete(ws.id);
  if (activeWs === ws) {
    const next = nextId ? workspaces.get(nextId) ?? null : null;
    if (next) activateWorkspace(next);
    else {
      activeWs = null;
      showView();
    }
  }
  updateCount();
  saveSession();
}

/** In-app confirm modal (unlike the native dialog, it can carry a "Don't ask
 *  again" checkbox). Resolves { ok, dontAsk }. */
function confirmModal(opts: {
  title: string;
  message: string;
  okLabel?: string;
  dontAsk?: boolean;
  input?: { placeholder?: string; value?: string };
}): Promise<{ ok: boolean; dontAsk: boolean; value: string }> {
  const m = document.getElementById("confirmModal") as HTMLElement;
  const okBtn = document.getElementById("cfOk") as HTMLButtonElement;
  const cancelBtn = document.getElementById("cfCancel") as HTMLButtonElement;
  const dontChk = document.getElementById("cfDontask") as HTMLInputElement;
  const inputRow = document.getElementById("cfInputRow") as HTMLElement;
  const inputEl = document.getElementById("cfInput") as HTMLInputElement;
  document.getElementById("cfTitle")!.textContent = opts.title;
  document.getElementById("cfMsg")!.textContent = opts.message;
  okBtn.textContent = opts.okLabel ?? "Confirm";
  (document.getElementById("cfDontaskRow") as HTMLElement).hidden = !opts.dontAsk;
  dontChk.checked = false;
  inputRow.hidden = !opts.input;
  if (opts.input) {
    inputEl.placeholder = opts.input.placeholder ?? "";
    inputEl.value = opts.input.value ?? "";
  }
  m.classList.add("open");
  if (opts.input) {
    inputEl.focus();
    inputEl.select();
  } else {
    okBtn.focus();
  }
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      m.classList.remove("open");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      m.removeEventListener("mousedown", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve({ ok, dontAsk: dontChk.checked, value: inputEl.value });
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e: MouseEvent) => {
      if (e.target === m) done(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(false);
      else if (e.key === "Enter") done(true);
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    m.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

const SKIP_WS_CLOSE = "maestro.skipWsCloseConfirm";
async function removeWorkspace(ws: Workspace) {
  if (ws.panes.size > 0 && localStorage.getItem(SKIP_WS_CLOSE) !== "1") {
    const { ok, dontAsk } = await confirmModal({
      title: "Close workspace",
      message: `Close "${ws.name}"? Its ${ws.panes.size} terminal(s) will be killed.`,
      okLabel: "Close workspace",
      dontAsk: true,
    });
    if (!ok) return;
    if (dontAsk) localStorage.setItem(SKIP_WS_CLOSE, "1");
  }
  for (const id of [...ws.panes.keys()]) await removeAgent(ws, id);
  dropWorkspace(ws);
}

const RESTART_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
const KILL_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const SEARCH_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
const MAX_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
const MIN_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h3a2 2 0 0 0 2-2V4M15 4v3a2 2 0 0 0 2 2h3M20 15h-3a2 2 0 0 0-2 2v3M9 20v-3a2 2 0 0 0-2-2H4"/></svg>';

function newId(): string {
  counter += 1;
  // Unique across page reloads too, so it never collides with a still-running
  // backend agent from a previous (HMR-reloaded) frontend session.
  return `agent-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.Failed === "string") return o.Failed;
    if (typeof o.message === "string") return o.message;
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}

function buildPaneEl(
  id: string,
  name: string,
  sub: string,
  badge: string,
  color: string,
  mono: string,
): HTMLElement {
  const el = document.createElement("section");
  el.className = "pane";
  el.dataset.id = id;
  el.innerHTML = `
    <div class="pane-head" data-drag>
      <span class="mono" style="--c:${color}">${CLI_LOGOS[badge] ?? mono}</span>
      <span class="pane-id">
        <span class="pane-name" title="${name}">${name}</span>
        <span class="pane-sub" data-sub title="${sub ? badge + " · " + sub : badge}">${sub ? badge + " · " + sub : badge}</span>
      </span>
      <span class="uptime" data-uptime></span>
      <span class="pane-stat" data-status>queued</span>
      <div class="ctrls">
        <button class="pctrl" data-search aria-label="Search output">${SEARCH_SVG}</button>
        <button class="pctrl" data-max aria-label="Maximize pane">${MAX_SVG}</button>
        <button class="pctrl" data-restart aria-label="Restart agent">${RESTART_SVG}</button>
        <button class="pctrl danger" data-kill aria-label="Kill agent (tree)">${KILL_SVG}</button>
      </div>
    </div>
    <div class="pane-find" data-find hidden>
      <input class="pane-find-in" data-find-in type="text" placeholder="Find in output…" spellcheck="false" />
      <span class="pane-find-count" data-find-count></span>
      <button class="pane-find-btn" data-find-prev aria-label="Previous match">&#8249;</button>
      <button class="pane-find-btn" data-find-next aria-label="Next match">&#8250;</button>
      <button class="pane-find-btn" data-find-close aria-label="Close search">${KILL_SVG}</button>
    </div>
    <div class="term-host" data-host></div>`;
  return el;
}

function setStatus(p: Pane, text: string, cls: "" | "run" | "err") {
  const s = p.el.querySelector<HTMLElement>("[data-status]");
  if (s) {
    s.textContent = text;
    s.className = "pane-stat" + (cls ? " " + cls : "");
  }
  p.el.classList.toggle("err", cls === "err");
  p.el.classList.toggle("run", cls === "run");
}

function updateCount() {
  let totalRun = 0;
  let total = 0;
  for (const w of workspaces.values()) {
    const run = [...w.panes.values()].filter((p) => p.running).length;
    totalRun += run;
    total += w.panes.size;
    const c = w.tabEl.querySelector<HTMLElement>(".tcount");
    if (c) c.textContent = w.panes.size ? String(w.panes.size) : "";
    w.tabEl.classList.toggle("live", run > 0);
  }
  const run = document.getElementById("runCount");
  if (run) run.textContent = String(totalRun);
  const tot = document.getElementById("agentCount");
  if (tot) tot.textContent = String(total);
  updateBcast();
  // Keep the tray tooltip in sync so a hidden window still shows it's alive.
  // The tray belongs to the main window; detached windows leave it alone.
  if (!isDetachedWindow) {
    const tip = totalRun > 0 ? `Maestro · ${totalRun} running` : "Maestro";
    void setTrayTooltip(tip).catch(() => {});
  }
}

interface AgentSpec {
  program: string;
  args: string[];
  cwd: string | null;
  name: string;
  badge: string;
  color: string;
  mono: string;
  worktree?: string;  // worktree path once created (isolated agents)
  branch?: string;    // the agent's git branch (isolated agents)
}

// Mount a pane immediately (status "queued…"); return a thunk that boots the
// real process. Splitting mount from boot lets the caller throttle booting so a
// big fleet doesn't spike the CPU all at once.
// When `restore` is true the pane is mounted in a STOPPED state (no PTY spawn) —
// session restore uses this so reopening doesn't auto-launch a heavy fleet.
// `attach` re-binds an ALREADY-RUNNING agent (tab detached from another window):
// the pane keeps the original agent id and the thunk calls pty_attach instead
// of spawning a new process.
function createAgent(
  ws: Workspace,
  spec: AgentSpec,
  restore = false,
  attach?: { id: string; spawnedAt: number | null },
): () => Promise<void> {
  // Make the (sized) workspace grid visible BEFORE mounting xterm, otherwise
  // fit() measures a display:none container as 0×0 and ConPTY paints the prompt
  // at the wrong size (blank pane).
  showWorkspace();
  const id = attach?.id ?? newId();
  const sub = spec.cwd ? basename(spec.cwd) : "";
  const el = buildPaneEl(id, spec.name, sub, spec.badge, spec.color, spec.mono);
  ws.gridEl.insertBefore(el, ws.gridEl.lastElementChild); // before the spawn tile

  const host = el.querySelector<HTMLElement>("[data-host]")!;
  const term = mountTerminal(
    host,
    (data) => {
      // Always forward keystrokes AND xterm's automatic answers (e.g. the ConPTY
      // cursor-position-report reply that unblocks the very first render) as long
      // as the pane still exists — never gate on `running`, or the early reply is
      // dropped and ConPTY stalls (blank pane).
      if (ws.panes.has(id)) void sendInput(id, data).catch(() => {});
    },
    (cols, rows) => {
      if (ws.panes.has(id)) void resizePty(id, cols, rows).catch(() => {});
    },
  );

  const pane: Pane = { id, el, term, running: false, spawnedAt: null, lastOutputAt: 0, color: spec.color, spec };
  ws.panes.set(id, pane);
  layoutGrid(ws);
  updateCount();

  // A restored pane is parked as "stopped" — no PTY is spawned until the user
  // hits ⟳ (which recreates the pane with restore=false → boots normally).
  if (restore) {
    setStatus(pane, "stopped", "");
    el.classList.add("stopped"); // dims the parked pane (cleared on boot)
    term.write(enc.encode("\r\n\x1b[90m  [stopped — click ⟳ to resume]\x1b[0m\r\n"));
  }

  el.querySelector("[data-kill]")?.addEventListener("click", () => void removeAgent(ws, id));
  el.querySelector("[data-restart]")?.addEventListener("click", async () => {
    await removeAgent(ws, id);
    await createAgent(ws, spec)();
  });
  el.querySelector("[data-max]")?.addEventListener("click", () => toggleMax(ws, pane));
  el.querySelector<HTMLElement>("[data-drag]")?.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest(".pctrl")) return; // ignore dbl-clicks on buttons
    toggleMax(ws, pane);
  });
  wirePaneSearch(pane);
  wirePaneDrag(ws, pane);

  saveSession();

  // Detach hand-off: the agent is already alive in the backend — just point
  // its output at this window. The backend replays buffered scrollback first.
  if (attach) {
    return async () => {
      if (!ws.panes.has(id)) return;
      const { cols, rows } = term.fit();
      try {
        await attachPty(id, (bytes) => {
          pane.lastOutputAt = Date.now();
          if (ws.panes.has(id)) term.write(bytes);
        });
        pane.running = true;
        pane.spawnedAt = attach.spawnedAt ?? Date.now();
        pane.lastOutputAt = Date.now();
        setStatus(pane, "running", "run");
        updateCount();
        void resizePty(id, cols, rows).catch(() => {});
      } catch {
        // Died between hand-off and attach — its pty-exit fired before we
        // were listening, so park it the way a normal exit would.
        pane.running = false;
        setStatus(pane, "exited", "");
        updateCount();
      }
    };
  }

  return async () => {
    if (!ws.panes.has(id)) return; // killed before its turn to boot
    const { cols, rows } = term.fit();
    try {
      // Isolated agents get their own worktree+branch; point the PTY cwd there.
      let cwd = spec.cwd;
      if (ws.isolated && ws.repoRoot && !spec.worktree) {
        try {
          spec.branch = branchName(spec.name, id.slice(-6));
          spec.worktree = await worktreeAdd(ws.repoRoot, spec.branch);
          cwd = spec.worktree;
          const subEl = el.querySelector<HTMLElement>("[data-sub]");
          if (subEl) subEl.textContent = spec.branch;
          saveSession();
        } catch (e) {
          term.write(enc.encode(`\r\n\x1b[33m[worktree failed, using project dir: ${errMsg(e)}]\x1b[0m\r\n`));
        }
      } else if (spec.worktree) {
        cwd = spec.worktree;
      }
      // Resolve npm/script CLIs (claude, codex, …) through cmd.exe /c so Windows
      // can actually launch them — see launchSpec.
      const launch = launchSpec(spec.program, spec.args);
      await spawnPty(id, launch.program, launch.args, cwd, cols, rows, (bytes) => {
        pane.lastOutputAt = Date.now();
        // After a tab detach this xterm is disposed but the PTY lives on (the
        // new window owns it) — never write into a dropped pane.
        if (ws.panes.has(id)) term.write(bytes);
      });
      pane.running = true;
      pane.spawnedAt = Date.now();
      pane.lastOutputAt = Date.now();
      setStatus(pane, "running", "run");
      updateCount();
      // Re-fit once the grid layout has settled; correct the PTY size if it moved.
      requestAnimationFrame(() => {
        const s = term.fit();
        if (s.cols !== cols || s.rows !== rows) void resizePty(id, s.cols, s.rows);
      });
    } catch (e) {
      setStatus(pane, "spawn failed", "err");
      term.write(enc.encode(`\r\n\x1b[31m[spawn failed: ${errMsg(e)}]\x1b[0m\r\n`));
    }
  };
}

async function removeAgent(ws: Workspace, id: string) {
  const p = ws.panes.get(id);
  if (!p) return;
  try {
    await killPty(id);
  } catch {
    /* ignore */
  }
  p.term.dispose();
  p.el.remove();
  ws.panes.delete(id);
  layoutGrid(ws);
  updateCount();
  saveSession();
}

/* ---------------- session persistence (restore tabs) ---------------- */

// Serialize every workspace + its agents' launch specs so the next launch can
// restore the same tabs (as STOPPED panes). Cheap, called on any set change.
// Detached windows save under their own key: if the whole app quits while they
// are open, the next launch's main window sweeps those keys back into tabs.
const SESSION_KEY = "maestro.session";
const DETACH_SESSION_PREFIX = "maestro.session.detach.";
const sessionKey = isDetachedWindow ? DETACH_SESSION_PREFIX + DETACH_KEY : SESSION_KEY;
function saveSession() {
  try {
    const data = [...workspaces.values()].map((w) => ({
      name: w.name,
      dir: w.dir,
      agents: [...w.panes.values()].map((p) => p.spec),
    }));
    localStorage.setItem(sessionKey, JSON.stringify(data));
  } catch {
    /* storage may be full/unavailable — best-effort only */
  }
}

/** Total panes parked in detached windows' session keys — main's quit confirm
 *  counts them so "N terminal(s) will be killed" covers the whole app. */
function detachedSessionCount(): number {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(DETACH_SESSION_PREFIX)) continue;
    try {
      const data = JSON.parse(localStorage.getItem(k) || "[]");
      if (Array.isArray(data))
        for (const w of data) n += Array.isArray(w?.agents) ? w.agents.length : 0;
    } catch {
      /* ignore */
    }
  }
  return n;
}

// Recreate one saved session blob's tabs + panes as STOPPED (no PTY spawn).
function restoreSessionBlob(raw: string | null) {
  let data: unknown;
  try {
    data = JSON.parse(raw || "[]");
  } catch {
    return; // invalid JSON — ignore
  }
  if (!Array.isArray(data) || data.length === 0) return;
  for (const saved of data) {
    if (!saved || typeof saved !== "object") continue;
    const w = saved as { name?: unknown; dir?: unknown; agents?: unknown };
    const dir = typeof w.dir === "string" ? w.dir : null;
    const name = typeof w.name === "string" ? w.name : undefined;
    const agents = Array.isArray(w.agents) ? (w.agents as AgentSpec[]) : [];
    const ws = createWorkspace(dir, name);
    for (const spec of agents) {
      if (spec && typeof spec.program === "string") createAgent(ws, spec, true); // stopped — don't boot
    }
  }
}

// Restore the previous session: the main window's own tabs, plus any leftover
// detached-window sessions (the app quit/crashed while they were open). The
// user resumes any pane via its ⟳ button. No-op when there's nothing saved.
function restoreSession() {
  restoreSessionBlob(localStorage.getItem(SESSION_KEY));
  const leftovers: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(DETACH_SESSION_PREFIX)) leftovers.push(k);
  }
  for (const k of leftovers) {
    restoreSessionBlob(localStorage.getItem(k));
    localStorage.removeItem(k);
  }
}

/* ---------------- detached-window boot ---------------- */
// Consume the hand-off payload written by detachWorkspace() in the original
// window: rebuild the workspace, re-attach to the still-running agents, and
// park the stopped ones exactly like a session restore.
function bootDetached(key: string) {
  const storeKey = `maestro.detach.${key}`;
  const raw = localStorage.getItem(storeKey);
  localStorage.removeItem(storeKey); // consumed exactly once
  if (!raw) return;
  let payload: DetachPayload;
  try {
    payload = JSON.parse(raw) as DetachPayload;
  } catch {
    return;
  }
  const ws = createWorkspace(payload.dir ?? null, payload.name);
  ws.repoRoot = typeof payload.repoRoot === "string" ? payload.repoRoot : null;
  ws.isolated = !!payload.isolated;
  const agents = Array.isArray(payload.agents) ? payload.agents : [];
  for (const a of agents) {
    if (!a?.spec || typeof a.spec.program !== "string") continue;
    if (a.running && typeof a.id === "string") {
      void createAgent(ws, a.spec, false, { id: a.id, spawnedAt: a.spawnedAt ?? null })();
    } else {
      createAgent(ws, a.spec, true); // was stopped — stays parked
    }
  }
}

/* ---------------- recent folders ---------------- */

const RECENT_KEY = "maestro.recent";
function getRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function addRecent(dir: string) {
  if (!dir) return;
  const list = [dir, ...getRecents().filter((d) => d !== dir)].slice(0, 6);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  renderRecents();
}
function renderRecents() {
  const wrap = document.getElementById("recents");
  const list = document.getElementById("recentsList");
  if (!wrap || !list) return;
  const r = getRecents();
  if (r.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  list.replaceChildren();
  for (const dir of r) {
    const b = document.createElement("button");
    b.className = "recent-chip";
    b.title = dir;
    b.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>${dir}</span>`;
    b.addEventListener("click", () => {
      openModal();
      mDir.value = dir;
    });
    list.appendChild(b);
  }
}

/* ---------------- spawn-setup modal ---------------- */

const STORE_KEY = "maestro.crew";
const MAX_CONCURRENT_BOOT = 3;
const modal = document.getElementById("spawnModal") as HTMLElement;
const mDir = document.getElementById("mDir") as HTMLInputElement;
const mCustom = document.getElementById("mCustom") as HTMLInputElement;
const crewGrid = document.getElementById("crewGrid") as HTMLElement;
const crewTotalEl = document.getElementById("crewTotal") as HTMLElement;
const spawnLabel = document.getElementById("mSpawnLabel") as HTMLElement;
const mSkipPerms = document.getElementById("mSkipPerms") as HTMLInputElement;
const mIsolate = document.getElementById("mIsolate") as HTMLInputElement;
const mIsolateRow = document.getElementById("mIsolateRow") as HTMLElement;

// Reveal the isolate toggle only when the working directory is a single git repo.
async function refreshIsolateToggle() {
  const dir = mDir.value.trim();
  let isRepo = false;
  if (dir) {
    try {
      isRepo = (await gitRepoRoot(dir)) !== null;
    } catch {
      isRepo = false;
    }
  }
  if (mDir.value.trim() !== dir) return; // dir changed while awaiting — drop stale result
  mIsolateRow.hidden = !isRepo;
}
mDir.addEventListener("change", () => void refreshIsolateToggle());

interface SavedCrew extends CrewState {
  dir: string;
  skipPerms: boolean;
}

let crew: CrewState = { counts: {}, custom: "", customCount: 0 };

function loadCrew(): SavedCrew {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return {
      counts: s.counts && typeof s.counts === "object" ? s.counts : {},
      custom: typeof s.custom === "string" ? s.custom : "",
      customCount: Number.isFinite(s.customCount) ? s.customCount : 0,
      dir: typeof s.dir === "string" ? s.dir : "",
      skipPerms: s.skipPerms === true,
    };
  } catch {
    return { counts: {}, custom: "", customCount: 0, dir: "", skipPerms: false };
  }
}

function renderCrew() {
  const total = expandCrew(crew).length;
  crewTotalEl.textContent = String(total);
  spawnLabel.textContent = total > 0 ? `Spawn ${total} agent${total > 1 ? "s" : ""}` : "Spawn";
  (document.getElementById("mSpawn") as HTMLButtonElement).disabled = total === 0;
  crewGrid.querySelectorAll<HTMLElement>(".crew-card").forEach((card) => {
    const id = card.dataset.id!;
    const n = crew.counts[id] ?? 0;
    card.classList.toggle("on", n > 0);
    const nEl = card.querySelector<HTMLElement>("[data-n]");
    if (nEl) nEl.textContent = String(n);
  });
  const cn = document.querySelector<HTMLElement>("[data-custom-n]");
  if (cn) cn.textContent = String(crew.customCount);
}

function buildCrewGrid() {
  crewGrid.replaceChildren();
  for (const p of CLI_PRESETS) {
    const card = document.createElement("div");
    card.className = "crew-card";
    card.dataset.id = p.id;
    const cmd = [p.program, ...p.args].join(" ");
    card.innerHTML = `
      <div class="cc-meta">
        <span class="cc-name">${p.label}</span>
        <span class="cc-badge" title="${cmd}">${cmd}</span>
      </div>
      <div class="stepper">
        <button type="button" data-dec aria-label="One fewer">−</button>
        <span class="n" data-n>0</span>
        <button type="button" data-inc aria-label="One more">+</button>
      </div>`;
    card.querySelector("[data-dec]")?.addEventListener("click", () => {
      crew.counts[p.id] = Math.max(0, (crew.counts[p.id] ?? 0) - 1);
      renderCrew();
    });
    card.querySelector("[data-inc]")?.addEventListener("click", () => {
      crew.counts[p.id] = Math.min(32, (crew.counts[p.id] ?? 0) + 1);
      renderCrew();
    });
    crewGrid.appendChild(card);
  }
}

// "new" → spawn into a fresh workspace tab; "current" → add to the active one.
let modalTarget: "new" | "current" = "new";
function openModal(mode: "new" | "current" = "new") {
  modalTarget = mode;
  const saved = loadCrew();
  crew = { counts: saved.counts, custom: saved.custom, customCount: saved.customCount };
  mDir.value = mode === "current" && activeWs ? activeWs.dir ?? "" : saved.dir;
  mCustom.value = crew.custom;
  mSkipPerms.checked = saved.skipPerms;
  renderCrew();
  void refreshIsolateToggle();
  modal.classList.add("open");
  mDir.focus();
  mDir.select();
}
function closeModal() {
  modal.classList.remove("open");
}

mCustom.addEventListener("input", () => {
  crew.custom = mCustom.value;
  renderCrew();
});
document.querySelector("[data-custom-stepper] [data-dec]")?.addEventListener("click", () => {
  crew.customCount = Math.max(0, crew.customCount - 1);
  renderCrew();
});
document.querySelector("[data-custom-stepper] [data-inc]")?.addEventListener("click", () => {
  crew.customCount = Math.min(32, crew.customCount + 1);
  renderCrew();
});

document.getElementById("mBrowse")?.addEventListener("click", async () => {
  const picked = await pickFolder(mDir.value || undefined);
  if (picked) {
    mDir.value = picked;
    mDir.focus();
  }
});

/** Core spawn: expand a crew → choose/create a workspace → mount & boot the
 *  fleet (concurrency-limited). Shared by the spawn modal and saved templates. */
async function spawnCrew(
  crewState: CrewState,
  dir: string | null,
  skipPerms: boolean,
  mode: "new" | "current",
): Promise<void> {
  const fleet = expandCrew(crewState);
  if (fleet.length === 0) return;

  // Name agents per CLI: "Claude Code #1", "Claude Code #2"; plain label when one.
  const perId: Record<string, number> = {};
  const totals: Record<string, number> = {};
  for (const p of fleet) totals[p.id] = (totals[p.id] ?? 0) + 1;

  // Spawn into the active workspace, or a brand-new tab.
  const ws = mode === "current" && activeWs ? activeWs : createWorkspace(dir);
  if (mode === "current" && activeWs && !activeWs.dir && dir) activeWs.dir = dir;

  // Decide isolation once per spawn: only for a fresh git-repo workspace when
  // the modal's toggle is on. (Existing isolated workspaces keep their setting.)
  if (!ws.isolated && dir) {
    const root = await gitRepoRoot(dir).catch(() => null);
    if (root && !mIsolateRow.hidden && mIsolate.checked) {
      ws.repoRoot = root;
      ws.isolated = true;
    }
  }

  const boots = fleet.map((p: CliPreset) => {
    perId[p.id] = (perId[p.id] ?? 0) + 1;
    const base = p.shell && dir ? basename(dir) : p.label;
    const name = totals[p.id] > 1 ? `${base} #${perId[p.id]}` : base;
    return createAgent(ws, {
      program: p.program,
      args: effectiveArgs(p, skipPerms),
      cwd: dir,
      name,
      badge: p.badge,
      ...cliLook(p.badge, p.label),
    });
  });

  // Boot through a concurrency-limited queue so many heavy CLIs don't all start
  // at once and spike the CPU (panes already appeared above as "queued…").
  await runLimited(boots, MAX_CONCURRENT_BOOT);
}

async function spawnFromModal() {
  const dir = mDir.value.trim() || null;
  crew.custom = mCustom.value;
  const skipPerms = mSkipPerms.checked;
  if (expandCrew(crew).length === 0) return;

  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      counts: crew.counts,
      custom: crew.custom,
      customCount: crew.customCount,
      dir: dir ?? "",
      skipPerms,
    }),
  );
  if (dir) addRecent(dir);
  closeModal();

  await spawnCrew(crew, dir, skipPerms, modalTarget);
}

buildCrewGrid();

document.getElementById("mSpawn")?.addEventListener("click", () => void spawnFromModal());
document.getElementById("mCancel")?.addEventListener("click", closeModal);
document.getElementById("mClose")?.addEventListener("click", closeModal);
modal.addEventListener("mousedown", (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modal.classList.contains("open")) closeModal();
});

/* ---------------- crew templates ---------------- */

interface Template {
  id: string;
  name: string;
  counts: Record<string, number>;
  custom: string;
  customCount: number;
  dir: string;
  skipPerms: boolean;
}

const TEMPLATES_KEY = "maestro.templates";

function loadTemplates(): Template[] {
  try {
    const v = JSON.parse(localStorage.getItem(TEMPLATES_KEY) || "[]");
    return Array.isArray(v) ? (v as Template[]) : [];
  } catch {
    return [];
  }
}
function saveTemplates(list: Template[]) {
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
}

/** Human-readable summary of a template's crew, e.g.
 *  "2× Claude Code · 1× Codex · my-app". */
function templateSummary(t: Template): string {
  const parts: string[] = [];
  for (const p of CLI_PRESETS) {
    const n = t.counts[p.id] ?? 0;
    if (n > 0) parts.push(`${n}× ${p.label}`);
  }
  const custom = (t.custom ?? "").trim();
  if (custom && t.customCount > 0) parts.push(`${t.customCount}× ${custom}`);
  if (t.dir) parts.push(basename(t.dir) || t.dir);
  return parts.join(" · ");
}

const tplModal = document.getElementById("tplModal") as HTMLElement;
const tplListEl = document.getElementById("tplList") as HTMLElement;

function renderTemplates() {
  const list = loadTemplates();
  tplListEl.replaceChildren();
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tpl-empty";
    empty.textContent = "No templates yet — save one from the New workspace dialog.";
    tplListEl.appendChild(empty);
    return;
  }
  for (const t of list) {
    const row = document.createElement("div");
    row.className = "tpl-row";
    row.innerHTML =
      `<div class="tpl-meta"><span class="tpl-name"></span><span class="tpl-sum"></span></div>` +
      `<div class="tpl-actions">` +
      `<button class="btn tpl-spawn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg> Spawn</button>` +
      `<button class="tpl-del" aria-label="Delete template">${KILL_SVG}</button>` +
      `</div>`;
    row.querySelector(".tpl-name")!.textContent = t.name;
    const sumEl = row.querySelector<HTMLElement>(".tpl-sum")!;
    const sum = templateSummary(t);
    sumEl.textContent = sum;
    sumEl.title = sum;
    row.querySelector(".tpl-spawn")!.addEventListener("click", async () => {
      closeTplModal();
      await spawnCrew(
        { counts: t.counts, custom: t.custom, customCount: t.customCount },
        t.dir || null,
        t.skipPerms,
        "new",
      );
    });
    row.querySelector(".tpl-del")!.addEventListener("click", () => {
      saveTemplates(loadTemplates().filter((x) => x.id !== t.id));
      renderTemplates();
    });
    tplListEl.appendChild(row);
  }
}

function openTplModal() {
  renderTemplates();
  tplModal.classList.add("open");
}
function closeTplModal() {
  tplModal.classList.remove("open");
}

document.getElementById("btnTemplates")?.addEventListener("click", openTplModal);
document.getElementById("tplClose")?.addEventListener("click", closeTplModal);
document.getElementById("tplCloseBtn")?.addEventListener("click", closeTplModal);
tplModal.addEventListener("mousedown", (e) => {
  if (e.target === tplModal) closeTplModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && tplModal.classList.contains("open")) closeTplModal();
});

document.getElementById("mSaveTpl")?.addEventListener("click", async () => {
  const dir = mDir.value.trim();
  crew.custom = mCustom.value;
  const skipPerms = mSkipPerms.checked;
  if (expandCrew(crew).length === 0) return;
  const defName = (dir ? basename(dir) : "") || "Crew template";
  const { ok, value } = await confirmModal({
    title: "Save template",
    message: "Name this crew template so you can spawn it again later.",
    okLabel: "Save",
    input: { placeholder: "Template name", value: defName },
  });
  if (!ok) return;
  const name = value.trim() || defName;
  const tpl: Template = {
    id: "tpl-" + Math.random().toString(36).slice(2, 9),
    name,
    counts: { ...crew.counts },
    custom: crew.custom,
    customCount: crew.customCount,
    dir,
    skipPerms,
  };
  saveTemplates([...loadTemplates(), tpl]);
});

/* ---------------- home + workspace triggers ---------------- */

document.getElementById("btnNewWorkspace")?.addEventListener("click", () => openModal("new"));
document.getElementById("btnNewAgent")?.addEventListener("click", () => openModal("current"));
tabAdd?.addEventListener("click", () => openModal("new"));
document.getElementById("btnHome")?.addEventListener("click", goHome);
document.getElementById("homeResume")?.addEventListener("click", resumeWorkspace);

document.getElementById("btnQuick")?.addEventListener("click", () => {
  const dir = getRecents()[0] ?? null;
  const ps = CLI_PRESETS.find((p) => p.id === "powershell")!;
  const ws = createWorkspace(dir);
  void createAgent(ws, {
    program: ps.program,
    args: ps.args,
    cwd: dir,
    name: dir ? basename(dir) : "powershell",
    badge: ps.badge,
    ...cliLook(ps.badge, ps.label),
  })();
});

/* ---------------- home mascot companion ---------------- */
// A friendly character on the Home screen. Two modes (Settings → Mascot):
//   • "move"  — strolls back and forth on its own
//   • "still" — stays put, idle
// In either mode it can be grabbed and dropped anywhere (position persists).
// The wrapper (#homeMascot) is translate(x,y)-positioned; the Mascot instance
// owns its own scale + facing flip. Strolling pauses when Home is off screen.
function initHomeMascot(): void {
  const host = document.getElementById("homeMascot");
  const home = document.getElementById("home");
  if (!host || !home || !Mascot.animations().includes("boy_idle")) return;

  const SPEED = 78; // px/sec — tuned so feet roughly match ground travel (low slide)
  const BOXW = 180,
    BOXH = 262; // .home-mascot box size (keep in sync with home.css)
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const m = new Mascot(host, { scale: 0.62, initial: "boy_idle" });
  void Mascot.preload(["boy_idle", "boy_walk"]);

  let mode: MascotMode = getMascotMode();
  let dragging = false;
  let moveAnim: Animation | null = null;
  let strollTimer = 0;

  const homeW = () => home.clientWidth || window.innerWidth;
  const homeH = () => home.clientHeight || window.innerHeight;
  const visible = () => !home.hidden && home.clientWidth > 0;
  const clamp = (p: { x: number; y: number }) => ({
    x: Math.min(Math.max(0, p.x), Math.max(0, homeW() - BOXW)),
    y: Math.min(Math.max(0, p.y), Math.max(0, homeH() - BOXH)),
  });
  // default resting spot: lower-left, feet ~30px above the Home bottom
  let pos = clamp(getMascotPos() ?? { x: 44, y: homeH() - BOXH - 30 });
  const apply = () => (host.style.transform = `translate(${pos.x}px, ${pos.y}px)`);
  apply();

  const stopStroll = () => {
    window.clearTimeout(strollTimer);
    moveAnim?.cancel();
    moveAnim = null;
  };

  const strollOnce = () => {
    if (mode !== "move" || dragging) return;
    if (!visible()) {
      strollTimer = window.setTimeout(strollOnce, 1200);
      return;
    }
    const maxX = Math.max(0, homeW() - BOXW);
    // A believable hop (160–360px) toward the side with more room.
    const dir = pos.x < maxX - pos.x ? 1 : -1;
    const target = Math.max(0, Math.min(maxX, pos.x + rand(160, 360) * (Math.random() < 0.8 ? dir : -dir)));
    const dist = Math.abs(target - pos.x);
    if (dist < 40) {
      strollTimer = window.setTimeout(strollOnce, 700);
      return;
    }
    const dur = (dist / SPEED) * 1000;
    m.setFacing(target < pos.x ? "left" : "right");
    m.play("boy_walk");
    // Walk along the current height (y): pre-set resting transform to the
    // destination, then animate current → destination so the hand-off to idle is
    // seamless (no fill-forwards pile-up).
    const from = pos.x;
    pos.x = target;
    apply();
    moveAnim = host.animate(
      [
        { transform: `translate(${from}px, ${pos.y}px)` },
        { transform: `translate(${target}px, ${pos.y}px)` },
      ],
      { duration: dur, easing: "linear" },
    );
    moveAnim.finished
      .then(() => {
        if (mode !== "move" || dragging) return;
        m.setFacing("right");
        m.play("boy_idle");
        strollTimer = window.setTimeout(strollOnce, rand(1800, 4200));
      })
      .catch(() => {}); // cancelled (drag / mode switch / teardown)
  };

  const applyMode = (next: MascotMode) => {
    mode = next;
    setMascotMode(next);
    stopStroll();
    m.setFacing("right");
    m.play("boy_idle");
    apply();
    if (mode === "move") strollTimer = window.setTimeout(strollOnce, 500);
  };

  /* ---- drag to place ---- */
  let grabDX = 0,
    grabDY = 0,
    grabPid = -1;
  m.el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    stopStroll();
    m.play("boy_idle"); // hold idle while being carried
    grabDX = e.clientX - pos.x;
    grabDY = e.clientY - pos.y;
    grabPid = e.pointerId;
    try {
      m.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    host.classList.add("dragging");
  });
  m.el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    pos = clamp({ x: e.clientX - grabDX, y: e.clientY - grabDY });
    apply();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    host.classList.remove("dragging");
    try {
      m.el.releasePointerCapture(grabPid);
    } catch {
      /* ignore */
    }
    setMascotPos(pos.x, pos.y);
    if (mode === "move") strollTimer = window.setTimeout(strollOnce, 500);
  };
  m.el.addEventListener("pointerup", endDrag);
  m.el.addEventListener("pointercancel", endDrag);

  /* ---- Settings → Mascot mode toggle ---- */
  const seg = document.getElementById("setMascotMode");
  const syncSeg = () =>
    seg?.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  seg?.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
    b.addEventListener("click", () => {
      applyMode((b.dataset.mode as MascotMode) ?? "move");
      syncSeg();
    }),
  );
  syncSeg();

  // Keep the mascot on-screen if the window is resized.
  window.addEventListener("resize", () => {
    pos = clamp(pos);
    if (!dragging && !moveAnim) apply();
  });

  if (mode === "move") strollTimer = window.setTimeout(strollOnce, 1500);
}
initHomeMascot();

/* ---------------- frameless window controls ---------------- */
initTitlebar(!isDetachedWindow);

/* ---------------- AI Code (read-only diff review) ---------------- */
setActiveDirProvider(() => activeWs?.dir ?? null);
initAiCode();

/* Pause decorative animations when the window is hidden/unfocused (saves GPU).
 * On resume, repaint everything: after a long idle / display sleep / tray stint,
 * WebView2 can drop its GPU surface to black and never repaint on its own. */
function repaintAfterResume() {
  // 1) Re-fit + resize every terminal. A pane whose WebGL context was lost has
  //    fallen back to the DOM renderer; the fit/resize forces it to redraw so it
  //    isn't left as a black canvas.
  for (const w of workspaces.values())
    for (const p of w.panes.values()) {
      const s = p.term.fit();
      if (p.running) void resizePty(p.id, s.cols, s.rows).catch(() => {});
    }
  // 2) Best-effort nudge for the whole webview: briefly create then drop a
  //    compositing layer so Chromium/WebView2 re-composites the surface in case
  //    the GPU process dropped the page to black. translateZ(0) doesn't move
  //    anything visually, so there's no flicker.
  const body = document.body;
  body.style.transform = "translateZ(0)";
  void body.offsetHeight; // force reflow so the layer is actually created
  requestAnimationFrame(() => {
    body.style.transform = "";
  });
}
initIdleAnimationPause(repaintAfterResume);

/* ---------------- broadcast input (type once → whole tab) ---------------- */
const bcast = document.getElementById("bcast") as HTMLElement;
const bcastInput = document.getElementById("bcastInput") as HTMLInputElement;
const bcastSend = document.getElementById("bcastSend") as HTMLButtonElement;
const bcastCountEl = document.getElementById("bcastCount");
const bcastEmitter = document.getElementById("bcastEmitter");
const bcastTargets = document.getElementById("bcastTargets");

function activeRunning(): Pane[] {
  return activeWs ? [...activeWs.panes.values()].filter((p) => p.running) : [];
}
function updateBcast() {
  const targets = activeRunning();
  const n = targets.length;
  if (bcastCountEl) bcastCountEl.textContent = `${n} agent${n === 1 ? "" : "s"}`;
  bcastSend.disabled = n === 0 || bcastInput.value.length === 0;
  bcastEmitter?.classList.toggle("live", n > 0);
  // one identity-colored dot per receiving agent (cap, then +N).
  if (bcastTargets) {
    const cap = 14;
    bcastTargets.replaceChildren();
    for (const p of targets.slice(0, cap)) {
      const d = document.createElement("span");
      d.className = "t";
      d.style.background = p.color;
      bcastTargets.appendChild(d);
    }
    if (n > cap) {
      const more = document.createElement("span");
      more.className = "bcast-count";
      more.style.marginLeft = "5px";
      more.textContent = `+${n - cap}`;
      bcastTargets.appendChild(more);
    }
  }
}
function flashPane(p: Pane) {
  p.el.classList.remove("recv");
  void p.el.offsetWidth; // restart the animation
  p.el.classList.add("recv");
  setTimeout(() => p.el.classList.remove("recv"), 520);
}
const bcastHistory: string[] = [];
let bcastHistIdx = 0; // points one past the newest entry

function broadcast() {
  const text = bcastInput.value;
  const targets = activeRunning();
  if (!text || targets.length === 0) return;
  for (const p of targets) {
    void sendInput(p.id, text + "\r").catch(() => {});
    flashPane(p);
  }
  if (bcastHistory[bcastHistory.length - 1] !== text) bcastHistory.push(text);
  bcastHistIdx = bcastHistory.length;
  bcastInput.value = "";
  updateBcast();
  bcastInput.focus();
  bcast.classList.remove("sent");
  void bcast.offsetWidth; // restart the ripple
  bcast.classList.add("sent");
  setTimeout(() => bcast.classList.remove("sent"), 560);
}
bcastInput.addEventListener("input", () => {
  bcastHistIdx = bcastHistory.length; // typing leaves history navigation
  updateBcast();
});
bcastInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    broadcast();
  } else if (e.key === "ArrowUp" && bcastHistory.length) {
    e.preventDefault();
    bcastHistIdx = Math.max(0, bcastHistIdx - 1);
    bcastInput.value = bcastHistory[bcastHistIdx] ?? "";
    updateBcast();
  } else if (e.key === "ArrowDown" && bcastHistory.length) {
    e.preventDefault();
    bcastHistIdx = Math.min(bcastHistory.length, bcastHistIdx + 1);
    bcastInput.value = bcastHistory[bcastHistIdx] ?? "";
    updateBcast();
  }
});
bcastSend.addEventListener("click", broadcast);

/* ---------------- clock ---------------- */
const clk = document.getElementById("clock");
function tick() {
  const d = new Date();
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  if (clk) clk.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  // Live uptime + active/idle activity on every running pane, across all workspaces.
  const now = Date.now();
  for (const w of workspaces.values())
    for (const pane of w.panes.values()) {
      if (pane.running && pane.spawnedAt != null) {
        const u = pane.el.querySelector<HTMLElement>("[data-uptime]");
        if (u) u.textContent = fmtUptime(now - pane.spawnedAt);
        // active (output flowing) vs idle (quiet, waiting at a prompt)
        const idle = now - pane.lastOutputAt > IDLE_MS;
        pane.el.classList.toggle("run", !idle);
        const s = pane.el.querySelector<HTMLElement>("[data-status]");
        const want = idle ? "idle" : "run";
        if (s && !s.classList.contains(want)) {
          s.className = "pane-stat " + want;
          s.textContent = idle ? "idle" : "running";
        }
      }
    }
}
tick();
setInterval(tick, 1000);

/* ---------------- init ---------------- */
renderRecents();
if (isDetachedWindow) {
  // A detached window must NOT kill-all (other windows' agents are alive) and
  // boots from its hand-off payload instead of the saved session.
  bootDetached(DETACH_KEY!);
} else {
  // On a fresh frontend load we've lost track of any backend agents (e.g. after
  // an HMR reload), so clear them to avoid orphans + id collisions.
  void killAll().catch(() => {});
  // Recreate last session's tabs as STOPPED panes (no PTY spawn) before showing
  // the view, so reopening the app doesn't auto-launch a heavy fleet.
  restoreSession();
}
showView();

/* Intro splash: plays once on first paint (CSS-driven), then we retire the
 * overlay and drop the `boot` gate so Home is fully interactive. Always plays
 * (the splash ignores the OS reduce-motion setting by design). Guarded with a
 * timeout so it can never trap input. */
{
  const intro = document.getElementById("intro");
  const clearIntro = () => {
    document.body.classList.remove("boot");
    intro?.remove();
  };
  // A detached window should feel like a continuation, not a fresh app launch.
  window.setTimeout(clearIntro, isDetachedWindow ? 0 : 1850);
}

// Silently check GitHub Releases for a newer signed build; prompts only if one
// exists. No-op in dev / when offline. Main window only — a detached window
// prompting in parallel would double the dialogs.
if (!isDetachedWindow) void checkForUpdates(true);

/* ---------------- file drag-drop → terminal ---------------- */
// Drop a file (e.g. a PDF) onto a pane and its path is typed into that agent's
// terminal — so you can then ask the AI to read it. The pane under the cursor
// is highlighted while dragging.
let dropTarget: Pane | null = null;
function paneAtPoint(x: number, y: number): Pane | null {
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(x / dpr, y / dpr)?.closest<HTMLElement>(".pane");
  const id = el?.dataset.id;
  return id && activeWs ? activeWs.panes.get(id) ?? null : null;
}
function setDropTarget(p: Pane | null) {
  if (p === dropTarget) return;
  dropTarget?.el.classList.remove("drop-target");
  dropTarget = p;
  dropTarget?.el.classList.add("drop-target");
}
void onDragDrop((e) => {
  if (e.type === "leave") return setDropTarget(null);
  if (e.type === "enter" || e.type === "over") {
    return setDropTarget(paneAtPoint(e.position.x, e.position.y));
  }
  // drop: type the (whitespace-quoted) path(s) into the targeted pane's PTY.
  const target = paneAtPoint(e.position.x, e.position.y) ?? dropTarget;
  setDropTarget(null);
  if (!target || e.paths.length === 0) return;
  const text = e.paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ") + " ";
  void sendInput(target.id, text).catch(() => {});
  target.term.focus();
});

/* pty-exit listener LAST + guarded so it can never block the wiring above. */
onExit((id, code) => {
  for (const w of workspaces.values()) {
    const p = w.panes.get(id);
    if (p) {
      p.running = false;
      p.spawnedAt = null;
      setStatus(p, `exited (${code})`, "");
      updateCount();
      break;
    }
  }
}).catch((e) => console.warn("pty-exit listener unavailable:", e));

/* ---------------- settings modal ---------------- */
const settingsModal = document.getElementById("settingsModal") as HTMLElement | null;
const setHideTray = document.getElementById("setHideTray") as HTMLInputElement | null;
const setVersion = document.getElementById("setVersion");
const setCheckUpdate = document.getElementById("setCheckUpdate") as HTMLButtonElement | null;

// Show the running version in the Settings "Updates" row.
void getVersion()
  .then((v) => { if (setVersion) setVersion.textContent = `Maestro v${v}`; })
  .catch(() => {});

// Manual update check. Unlike the silent startup check, this one always reports
// back (up to date / error), and guards against double-clicks while it runs.
setCheckUpdate?.addEventListener("click", async () => {
  setCheckUpdate.disabled = true;
  const label = setCheckUpdate.textContent;
  setCheckUpdate.textContent = "Checking…";
  try {
    await checkForUpdates(false);
  } finally {
    setCheckUpdate.disabled = false;
    setCheckUpdate.textContent = label;
  }
});

function openSettings() {
  if (setHideTray) setHideTray.checked = getHideToTray();
  settingsModal?.classList.add("open");
}
function closeSettings() {
  settingsModal?.classList.remove("open");
}

setHideTray?.addEventListener("change", () => {
  const on = setHideTray.checked;
  setHideToTray(on);
  void setTrayVisible(on).catch((e) => console.warn("set tray visibility failed:", e));
});

document.getElementById("btnSettings")?.addEventListener("click", openSettings);
document.getElementById("btnSettingsHome")?.addEventListener("click", openSettings);
document.getElementById("setClose")?.addEventListener("click", closeSettings);
document.getElementById("setCloseBtn")?.addEventListener("click", closeSettings);
settingsModal?.addEventListener("mousedown", (e) => {
  if (e.target === settingsModal) closeSettings();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && settingsModal?.classList.contains("open")) closeSettings();
});

/* ---------------- close / quit / hide-to-tray ---------------- */
let closing = false;

function ownPaneCount(): number {
  let total = 0;
  for (const w of workspaces.values()) total += w.panes.size;
  return total;
}

/** Full quit (MAIN window): confirm if terminals are running anywhere, kill
 *  them all, tell detached windows to close, destroy. Used by the X button
 *  (when hide-to-tray is off) and the tray "Quit". */
async function quitApp(): Promise<void> {
  if (closing) return;
  const total = ownPaneCount() + detachedSessionCount();
  if (needsCloseConfirm(total)) {
    const ok = await confirmDialog(`${total} running terminal(s) will be killed. Quit Maestro?`, "Quit Maestro");
    if (!ok) return;
  }
  closing = true;
  try {
    await killAll();
  } catch {
    /* ignore */
  }
  // Detached windows die with the app (their agents were just killed).
  try {
    await broadcastQuit();
  } catch {
    /* ignore */
  }
  await destroyWindow();
}

/** Close a DETACHED window: kill only ITS agents, drop its session key, and
 *  leave every other Maestro window untouched. */
async function closeDetachedWindow(): Promise<void> {
  if (closing) return;
  const total = ownPaneCount();
  if (needsCloseConfirm(total)) {
    const ok = await confirmDialog(`${total} running terminal(s) will be killed. Close this window?`, "Close window");
    if (!ok) return;
  }
  closing = true;
  for (const w of workspaces.values()) {
    for (const id of w.panes.keys()) {
      try {
        await killPty(id);
      } catch {
        /* ignore */
      }
    }
  }
  localStorage.removeItem(sessionKey); // nothing to sweep on next launch
  await destroyWindow();
}

// The X button always quits this window (with a kill confirm when terminals
// run). "Hide to tray" is bound to the minimize button instead — see titlebar.ts.
void onWindowClose(async (event) => {
  if (closing) return;
  event.preventDefault();
  await (isDetachedWindow ? closeDetachedWindow() : quitApp());
}).catch((e) => console.warn("close handler unavailable:", e));

if (isDetachedWindow) {
  // Main quit (X / tray) broadcasts after its kill-all — just fold this window.
  // The session key is left in place ON PURPOSE: the next launch's main window
  // sweeps it back into a (stopped) tab, same as the main window's own tabs.
  void onAppQuit(() => {
    closing = true;
    void destroyWindow();
  }).catch((e) => console.warn("app-quit listener unavailable:", e));
} else {
  // Tray "Quit" → same full-quit flow (Rust already re-showed the window so the
  // confirm dialog is visible).
  void onTrayQuit(() => quitApp()).catch((e) => console.warn("tray-quit listener unavailable:", e));

  // Mirror the tray icon's visibility to the saved setting on boot.
  void setTrayVisible(getHideToTray()).catch((e) => console.warn("set tray visibility failed:", e));
}
