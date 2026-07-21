// Styles are loaded via a render-blocking <link> in index.html (not imported
// here) so the first paint is fully styled — see the note in index.html.
import { mountTerminal } from "./terminal";
import {
  spawnPty,
  attachPty,
  sendInput,
  resizePty,
  killPty,
  killAll,
  onExit,
  onWindowClose,
  confirmDialog,
  destroyWindow,
  hideWindow,
  setTrayVisible,
  setTrayTooltip,
  onTrayQuit,
  worktreeAdd,
  onDragDrop,
  openDetachWindow,
  broadcastQuit,
  onAppQuit,
  emitAppEvent,
  onAppEvent,
  focusThisWindow,
  openExternal,
  notify,
  recordStart,
  recordStop,
} from "./ipc";
import { branchName } from "./worktree";
import {
  getHideToTray,
  getMascotMode,
  setMascotMode,
  getMascotPos,
  setMascotPos,
  getTermFontSize,
  type MascotMode,
} from "./settings";
import { CLI_PRESETS, launchSpec } from "./crew";
import { parseLayout } from "./canvas";
import { type Pane, type Workspace, type AgentSpec } from "./panetypes";
import { configurePaneLayout, layoutGrid, tidyLayout, toggleMax, wirePaneDrag, wirePaneRename } from "./panelayout";
import { configureBroadcast, initBroadcast, updateBcast, focusBroadcast } from "./broadcast";
import { configureRecents, getRecents, renderRecents } from "./recents";
import { configureUsage, initUsage } from "./usage";
import { configureReplay, initReplay, openReplays, REC_DIR_REL } from "./replay";
import { configureDashboard, initDashboard } from "./dashboard";
import { configureSpawnModal, initSpawnModal, openModal, spawnCrew, spawnForConductor, loadCrew, renderCrew, loadTemplates, saveTemplates, templateSummary } from "./spawnmodal";
import { configureWizard, initWizard, openWizard, isPresetAvailable, refreshCliAvailability, launchPreset } from "./wizard_ui";
import { closeSettings, initSettingsModal } from "./settingsmodal";
import { configureSession, saveSession, restoreSession, detachedSessionCount, sessionKey } from "./session";
import { configureScheduler, initScheduler } from "./scheduler";
import { workspaces, activeWs, setActiveWs, newId, nextWsId } from "./appstate";
import { basename, nextWorkspaceName, pickNextActive, needsCloseConfirm } from "./workspaces";
import { checkForUpdates } from "./updater";
import { initTitlebar } from "./titlebar";
import { initIdleAnimationPause } from "./power";
import { initDock, dockSetContext, dockToggle, dockOpen } from "./dock";
import { Mascot } from "./mascot";
import { initPanels } from "./panels";
import { initFileTree } from "./filetree";
import { initEditor } from "./editor";
import {
  setAgentSender,
  setFileOpener,
  setDiffOpener,
  setPaneTargeting,
  setFleet,
  setAgentSenderById,
  setPaneFocuser,
  setFleetSnapshot,
  setPaneRevealer,
  type FleetPane,
} from "./agentbridge";
import { initFleetBridge } from "./fleetbridge";
import { paneStatus } from "./fleet";

/* Home launcher ⇄ Workspace grid.
 * Home is shown while there are 0 agents (the prominent "create" entry).
 * Spawning agents switches to the Workspace; closing them all returns Home.
 * Each agent = its own real ConPTY process; closing a pane tree-kills it. */


// No PTY output for this long while alive ⇒ the agent is idle (waiting at a prompt).
const IDLE_MS = 1200;

// The board protocol every Maestro-spawned Claude agent is forced to follow
// (injected via --append-system-prompt). One line, and free of cmd.exe
// metacharacters (& | < > % ! ^ ( ) " ') so it survives the cmd /c launch path.
const MAESTRO_LAWS =
  "You are running inside Maestro, which gives this workspace a shared kanban board through the maestro MCP tools. For any non-trivial task you MUST plan on the board before implementing. First call board_get. Then for each deliverable call card_add in the Proposed list with a short title, a one-line desc, and the small concrete steps as the checklist array. Prefer few big cards over many tiny ones. Wait for the user to approve by moving cards to To do. While working, card_move your card to Doing when you start it and card_done with a one-line summary when it is finished. Keep card titles stable so the board can track them.";

// The conductor role: orchestrate the fleet, do not implement. Single line, free
// of cmd.exe metacharacters so it survives the cmd /c launch path.
const CONDUCTOR_LAWS =
  "You are the CONDUCTOR of a Maestro agent fleet, not a worker. Do NOT write code or do tasks yourself. Orchestrate through the maestro MCP tools. When the user gives you a goal: call board_get, break the goal into cards with card_add, then spawn worker agents with agent_spawn and hand each worker a specific card with fleet_send. Track progress with fleet_status and agent_output, read a worker screen when it looks stuck, move cards with card_move, and mark card_done when a worker reports finished. Keep every worker busy and the board current until the goal is complete. Spawn more workers if there is idle capacity and pending work.";

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

const enc = new TextEncoder();

// A detached window (a tab dragged out of another Maestro window) boots with
// ?detach=<key> pointing at its localStorage hand-off payload. It skips the
// main window's app-global duties (kill-all, session restore, tray, updates).
const DETACH_KEY = new URLSearchParams(location.search).get("detach");
const isDetachedWindow = DETACH_KEY !== null;

const homeEl = document.getElementById("home") as HTMLElement;
const appEl = document.getElementById("app") as HTMLElement;
const wsHost = document.getElementById("workspaces") as HTMLElement;
// The project rail replaces the old horizontal tab strip. `railList` holds the
// `.proj` rows; the old `tabstrip`/`tabAdd` names are kept as aliases so the
// rest of the workspace logic (drag, order, rename) stays untouched.
const railList = document.getElementById("railList") as HTMLElement;
const railAdd = document.getElementById("railAdd") as HTMLElement;
const tabstrip = railList;
const tabAdd = railAdd;

// Code panel (right): file tree + editor, wired up in the startup block.
let fileTree: { setRoot(dir: string | null): void } | null = null;

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
/** Show the "Resume all" topbar button when the active workspace has any parked
 *  (stopped) or exited pane, with a live count — so the whole fleet can be booted
 *  in one click instead of hitting ⟳ on every pane. */
function syncResumeAll() {
  const btn = document.getElementById("btnResumeAll");
  if (!btn) return;
  const n = activeWs ? [...activeWs.panes.values()].filter((p) => !p.running).length : 0;
  btn.hidden = n === 0;
  const c = document.getElementById("btnResumeAllCount");
  if (c) c.textContent = n ? String(n) : "";
}
/** Boot every non-running pane in the active workspace, one at a time. Mirrors a
 *  pane's ⟳ (removeAgent → createAgent), but SEQUENTIALLY on purpose: a parallel
 *  fleet spawn hammers ConPTY + git worktree_add and freezes the UI (see the
 *  sync-spawn freeze fix). Specs are snapshot first because booting swaps each
 *  pane for a fresh id, which would mutate the map mid-iteration. */
let resumingAll = false;
async function resumeAllStopped() {
  if (resumingAll || !activeWs) return;
  const ws = activeWs;
  const targets = [...ws.panes.values()].filter((p) => !p.running).map((p) => ({ id: p.id, spec: p.spec }));
  if (!targets.length) return;
  resumingAll = true;
  const btn = document.getElementById("btnResumeAll") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    for (const t of targets) {
      if (!ws.panes.has(t.id)) continue; // killed before its turn
      await removeAgent(ws, t.id);
      await createAgent(ws, t.spec)();
    }
  } finally {
    resumingAll = false;
    if (btn) btn.disabled = false;
    syncResumeAll();
  }
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
  const id = nextWsId();
  // A restored tab passes its original name; otherwise auto-name it.
  const wsName = name ?? nextWorkspaceName(dir, [...workspaces.values()].map((w) => w.name));

  const gridEl = document.createElement("div");
  gridEl.className = "grid canvas";
  const tile = document.createElement("button");
  tile.className = "tile-spawn";
  tile.innerHTML = SPAWN_TILE_SVG;
  tile.addEventListener("click", () => openModal("current"));
  gridEl.appendChild(tile);
  wsHost.appendChild(gridEl);

  const tabEl = document.createElement("button");
  tabEl.className = "tab";
  tabEl.innerHTML =
    `<span class="tdot"></span><span class="tname"></span><span class="tcount"></span>` +
    `<button class="tclose" aria-label="Close workspace">${KILL_SVG}</button>`;
  tabEl.querySelector(".tname")!.textContent = wsName;
  tabEl.dataset.ws = id;
  railList.appendChild(tabEl);

  const ws: Workspace = { id, name: wsName, dir, repoRoot: null, isolated: false, gridEl, tabEl, panes: new Map(), bcastSelected: new Set(), layout: new Map(Object.entries(parseLayout(localStorage.getItem(`maestro.canvas.${dir ?? id}`)))) };
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
  setActiveWs(ws);
  for (const w of workspaces.values()) {
    w.gridEl.hidden = w !== ws;
    w.tabEl.classList.toggle("active", w === ws);
  }
  showWorkspace();
  updateBcast();
  syncResumeAll(); // the newly-active tab may have its own parked panes
  // Re-scope the tool dock (board / timer / diff) to this workspace's folder.
  dockSetContext({ key: ws.dir || ws.id, dir: ws.dir });
  // Re-root the code panel's file tree to this workspace's folder.
  fileTree?.setRoot(ws.dir);
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
  const toggle = () => (bar.hidden ? open() : close());
  pane.toggleFind = toggle; // lets the Ctrl+Shift+F shortcut drive it externally
  el.querySelector("[data-search]")?.addEventListener("click", toggle);
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
// Free-position a pane by dragging its title bar (Pointer Events — WebView2
// breaks HTML5 DnD). Updates the workspace canvas layout live and persists on
// release. A near-zero drag is treated as a click (leaves focus handling alone).
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

      // --- CROSS-WINDOW DRAG PAYLOAD ---
      const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const payload = buildDetachPayload(ws);
      e.dataTransfer.setData("application/maestro-workspace", JSON.stringify({ key, ws: payload }));

      const pUnlisten = onAppEvent<{ key: string }>(MERGE_ACK_EVT, (a) => {
        if (a?.key === key) {
           dropWorkspace(ws);
           if (isDetachedWindow && workspaces.size === 0) void destroyWindow();
           pUnlisten.then(f => f());
        }
      });
      window.setTimeout(() => pUnlisten.then(f => f()), 10000);
    }
  });
  el.addEventListener("dragend", (e) => {
    el.classList.remove("dragging");
    tabstrip.classList.remove("reordering");
    const src = tabDragSrc;
    tabDragSrc = null;
    if (!src || !workspaces.has(src.id)) return;
    // Released beyond the viewport → tear the tab out into its own window.
    // Note: Cross-window drops are handled by the document.body drop listener.
    const out =
      !tabDragInside ||
      e.clientX < 0 ||
      e.clientY < 0 ||
      e.clientX > window.innerWidth ||
      e.clientY > window.innerHeight;
    if (out) {
      // In a detached window, dragging a tab out first tries to fold it back
      // into the main window; only if the main window is gone do we tear it out
      // into a brand-new window (the original detach behaviour).
      if (isDetachedWindow) {
        void mergeWorkspaceToMain(src).then((ok) => {
          if (!ok) void detachWorkspace(src);
        });
      } else void detachWorkspace(src);
    } else commitTabOrder();
  });
  el.addEventListener("dragover", (e) => {
    if (tabDragSrc === ws) return;
    const isCrossWindow = !tabDragSrc && Array.from(e.dataTransfer?.types || []).includes("application/maestro-workspace");
    if (!tabDragSrc && !isCrossWindow) return;

    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    
    const r = el.getBoundingClientRect();
    const before = e.clientX - r.left < r.width / 2;

    if (isCrossWindow) {
      document.querySelectorAll(".tab.drop-before, .tab.drop-after").forEach(t => t.classList.remove("drop-before", "drop-after"));
      el.classList.add(before ? "drop-before" : "drop-after");
      return;
    }
    if (!tabDragSrc) return;
    railList.insertBefore(tabDragSrc.tabEl, before ? el : el.nextSibling);
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("drop-before", "drop-after");
  });
  el.addEventListener("drop", (e) => {
    el.classList.remove("drop-before", "drop-after");
    e.preventDefault();
    
    const dt = e.dataTransfer;
    if (!tabDragSrc && dt && Array.from(dt.types).includes("application/maestro-workspace")) {
      e.stopPropagation(); // prevent body from handling it (which appends to end)
      dragWsCount = 0;
      document.body.classList.remove("drag-over-ws");
      const raw = dt.getData("application/maestro-workspace");
      if (raw) {
        try {
          const msg = JSON.parse(raw) as MergeMsg;
          adoptWorkspace(msg.ws);
          
          // Move the newly adopted workspace (currently last) to the exact drop spot
          const r = el.getBoundingClientRect();
          const before = e.clientX - r.left < r.width / 2;
          const newTab = railList.lastElementChild;
          if (newTab && newTab !== el) {
            railList.insertBefore(newTab, before ? el : el.nextSibling);
            commitTabOrder();
          }
          
          void emitAppEvent(MERGE_ACK_EVT, { key: msg.key });
          void focusThisWindow().catch(() => {});
        } catch (err) {
          console.warn("cross-window drag parse failed", err);
        }
      }
    }
  });
}

// Rebuild the workspaces Map to match the tabstrip's DOM order, then persist —
// session save iterates the Map, so the order survives restarts.
function commitTabOrder() {
  const ordered: Workspace[] = [];
  railList.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
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

/** Snapshot a workspace into a hand-off payload (running agents are referenced
 *  by id so the receiver can re-attach via `pty_attach`; stopped ones stay
 *  parked). Shared by detach (→ new window) and merge-back (→ main window). */
function buildDetachPayload(ws: Workspace): DetachPayload {
  return {
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
}

/** Hand-off done: drop `ws`'s tab locally WITHOUT killing its PTYs. Their output
 *  keeps flowing into the backend scrollback buffer until the receiving window
 *  attaches. Shared by detach and merge-back. */
function releaseWorkspace(ws: Workspace) {
  for (const p of ws.panes.values()) {
    p.term.dispose();
    p.el.remove();
  }
  ws.panes.clear();
  dropWorkspace(ws);
}

/** Move `ws` into a brand-new Maestro window. Running agents are NOT killed:
 *  the new window re-attaches to their PTYs (`pty_attach`) and the backend
 *  replays the recent scrollback. This window just drops its tab. */
async function detachWorkspace(ws: Workspace) {
  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = buildDetachPayload(ws);
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
  // Hand-off succeeded: drop the tab locally WITHOUT killing its PTYs.
  releaseWorkspace(ws);
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
      setActiveWs(null);
      showView();
    }
  }
  updateCount();
  saveSession();
}

/* ---------------- merge back into the main window ---------------- */
// The mirror of detach: a workspace in a DETACHED window can be folded BACK into
// the main window. We use Tauri's app-global event bus (emit/listen) with an ack
// handshake — the detached window only releases the tab once the main window
// confirms it adopted it, so the workspace is never dropped if the main window
// is gone (then we fall back to leaving the tab / detaching into a new window).
const MERGE_EVT = "maestro://merge";
const MERGE_ACK_EVT = "maestro://merge-ack";
interface MergeMsg {
  key: string;
  ws: DetachPayload;
}

// Main-window side: adopt any workspace another window asks us to merge in, ack
// it (keyed so the sender knows which request completed), and surface ourselves.
if (!isDetachedWindow) {
  void onAppEvent<MergeMsg>(MERGE_EVT, (m) => {
    adoptWorkspace(m.ws);
    void emitAppEvent(MERGE_ACK_EVT, { key: m.key });
    void focusThisWindow().catch(() => {});
  });
}

let dragWsCount = 0;
document.body.addEventListener("dragenter", (e) => {
  if (Array.from(e.dataTransfer?.types || []).includes("application/maestro-workspace")) {
    dragWsCount++;
    if (dragWsCount === 1) document.body.classList.add("drag-over-ws");
  }
});
document.body.addEventListener("dragleave", (e) => {
  if (Array.from(e.dataTransfer?.types || []).includes("application/maestro-workspace")) {
    dragWsCount--;
    if (dragWsCount === 0) document.body.classList.remove("drag-over-ws");
  }
});

// Support dropping workspaces from ANY other window
document.body.addEventListener("dragover", (e) => {
  const dt = e.dataTransfer;
  if (dt && Array.from(dt.types).includes("application/maestro-workspace")) {
    e.preventDefault();
    dt.dropEffect = "move";
  }
});

document.body.addEventListener("drop", (e) => {
  const dt = e.dataTransfer;
  if (dt && Array.from(dt.types).includes("application/maestro-workspace")) {
    e.preventDefault();
    dragWsCount = 0;
    document.body.classList.remove("drag-over-ws");
    const raw = dt.getData("application/maestro-workspace");
    if (raw) {
      try {
        const msg = JSON.parse(raw) as MergeMsg;
        adoptWorkspace(msg.ws);
        void emitAppEvent(MERGE_ACK_EVT, { key: msg.key });
        void focusThisWindow().catch(() => {});
      } catch (err) {
        console.warn("cross-window drag parse failed", err);
      }
    }
  }
});

/** Detached-window side: hand `ws` back to the main window and (on success)
 *  release the tab here. Returns false if the main window never acked within the
 *  timeout (closed / not listening) — caller then leaves the tab untouched. */
async function mergeWorkspaceToMain(ws: Workspace): Promise<boolean> {
  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = buildDetachPayload(ws);

  // The ack handler closes over this call's `resolve`/`timer`. We settle on the
  // first of: a matching ack (success) or a ~2s timeout (main window gone).
  let resolveAcked!: (ok: boolean) => void;
  const ackedP = new Promise<boolean>((resolve) => (resolveAcked = resolve));
  const timer = window.setTimeout(() => resolveAcked(false), 2000);

  // Subscribe to the ack (filtered by our key) BEFORE emitting, so a fast main
  // window can't ack into the void. Unlisten on every exit path.
  const unlisten = await onAppEvent<{ key: string }>(MERGE_ACK_EVT, (a) => {
    if (a?.key === key) {
      window.clearTimeout(timer);
      resolveAcked(true);
    }
  });
  try {
    void emitAppEvent(MERGE_EVT, { key, ws: payload } satisfies MergeMsg);
    const acked = await ackedP;
    if (!acked) return false; // main window gone — leave the tab where it is
    releaseWorkspace(ws);
    if (workspaces.size === 0) void destroyWindow(); // this window is now empty
    return true;
  } finally {
    window.clearTimeout(timer);
    unlisten();
  }
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
// A filled dot — the record button; the ".rec" class pulses it red while active.
const REC_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>';

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
  _sub: string,
  badge: string,
  _color: string,
): HTMLElement {
  const el = document.createElement("section");
  el.className = "pane";
  el.dataset.id = id;
  // Slim draggable title bar: status dot · editable name · CLI badge · controls.
  // Controls keep their data-* attributes so the existing wiring in createAgent
  // still binds. `[data-drag]` on the bar is the canvas move handle.
  el.innerHTML = `
    <div class="pane-bar" data-drag>
      <span class="pb-dot"></span>
      <span class="pb-name pane-name">${name}</span>
      <span class="pb-cli">${badge}</span>
      <span class="pb-sp"></span>
      <div class="pb-ctrls ctrls">
        <button class="pctrl" data-search aria-label="Search output">${SEARCH_SVG}</button>
        <button class="pctrl rec-btn" data-record aria-label="Record session">${REC_SVG}</button>
        <button class="pctrl" data-max aria-label="Focus pane">${MAX_SVG}</button>
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

function setStatus(p: Pane, text: string, cls: "" | "run" | "err" | "wait") {
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
  syncResumeAll(); // parked/exited count may have changed
  // Keep the tray tooltip in sync so a hidden window still shows it's alive.
  // The tray belongs to the main window; detached windows leave it alone.
  if (!isDetachedWindow) {
    const tip = totalRun > 0 ? `Maestro · ${totalRun} running` : "Maestro";
    void setTrayTooltip(tip).catch(() => {});
  }
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
  const el = buildPaneEl(id, spec.name, sub, spec.badge, spec.color);
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
      pane.lastInputAt = Date.now();
      clearAttention(pane); // the user is interacting → not waiting on them
    },
    (cols, rows) => {
      if (ws.panes.has(id)) void resizePty(id, cols, rows).catch(() => {});
    },
    { openLink: (url) => void openExternal(url).catch(() => {}), fontSize: getTermFontSize() },
  );

  // The persona name owns the title bar now; surface the terminal's own title
  // as a hover tooltip instead of overwriting the name.
  term.onTitleChange((title) => {
    if (title.trim()) el.title = title;
  });

  const pane: Pane = { id, el, term, running: false, spawnedAt: null, lastOutputAt: 0, lastInputAt: 0, attention: false, attentionClearedAt: 0, attentionNotified: false, color: spec.color, spec };
  ws.panes.set(id, pane);
  ws.bcastSelected.add(id);
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
  el.querySelector("[data-record]")?.addEventListener("click", () => void toggleRecord(ws, pane));
  el.querySelector("[data-restart]")?.addEventListener("click", async () => {
    await removeAgent(ws, id);
    await createAgent(ws, spec)();
  });
  el.querySelector("[data-max]")?.addEventListener("click", () => toggleMax(ws, pane));
  el.querySelector<HTMLElement>("[data-drag]")?.addEventListener("dblclick", (e) => {
    const tgt = e.target as HTMLElement;
    if (tgt.closest(".pctrl") || tgt.closest(".pb-name")) return; // buttons + rename aren't focus triggers
    toggleMax(ws, pane);
  });
  wirePaneSearch(pane);
  wirePaneDrag(ws, pane);
  wirePaneRename(ws, pane);
  // Clicking / focusing into a flagged pane means the user is now looking at it.
  el.addEventListener("pointerdown", () => clearAttention(pane));
  el.addEventListener("focusin", () => clearAttention(pane));

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
          if (pane.attention) clearAttention(pane); // agent is producing output again
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
      // Enforce Maestro's protocol at the system-prompt level so a Claude agent
      // MUST follow it (not a soft MCP hint, not a button). A conductor gets the
      // orchestration prompt; every other Claude gets the plan-first worker one.
      // Only claude exposes --append-system-prompt; other CLIs still get the MCP
      // tools + server instructions. New array — never mutate spec.args, or a
      // restart would append the flag again and again.
      const laws = spec.role === "conductor" ? CONDUCTOR_LAWS : MAESTRO_LAWS;
      const args =
        spec.badge === "claude" ? [...spec.args, "--append-system-prompt", laws] : spec.args;
      // Resolve npm/script CLIs (claude, codex, …) through cmd.exe /c so Windows
      // can actually launch them — see launchSpec.
      const launch = launchSpec(spec.program, args);
      // Identity for the child process: maestro-mcp uses MAESTRO_AGENT to
      // stamp who moved/finished a board card (see mcp/src/server.ts).
      const envPairs: Array<[string, string]> = [
        ["MAESTRO_AGENT", spec.name],
        ["MAESTRO_WORKSPACE", cwd ?? ""],
      ];
      await spawnPty(id, launch.program, launch.args, cwd, cols, rows, envPairs, (bytes) => {
        pane.lastOutputAt = Date.now();
        if (pane.attention) clearAttention(pane); // agent is producing output again
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
  if (p.recording) await stopRecording(p); // flush the recording before the PTY dies
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
  refreshAttnTabs(); // the removed pane may have been the tab's only alert
  saveSession();
}

/* ---------------- session recording (replay) ---------------- */

// Recordings live under the workspace's own .maestro folder so the player can
// list them per project (see openReplays). Path uses forward slashes — Rust's
// Path handles them on Windows and create_dir_all makes the folder.

/** Reflect a pane's REC button state (pulsing dot + label). */
function setRecUi(p: Pane): void {
  const btn = p.el.querySelector<HTMLElement>("[data-record]");
  if (!btn) return;
  const on = !!p.recording;
  btn.classList.toggle("rec", on);
  btn.setAttribute("aria-label", on ? "Stop recording" : "Record session");
  p.el.classList.toggle("recording", on);
}

/** Transient bottom-right toast (reuses the kanban toast style). */
function paneToast(text: string, onClick?: () => void): void {
  const t = document.createElement("div");
  t.className = "kb-toast";
  t.textContent = text;
  if (onClick) {
    t.style.cursor = "pointer";
    t.addEventListener("click", () => {
      onClick();
      t.remove();
    });
  }
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("on"));
  window.setTimeout(() => {
    t.classList.remove("on");
    window.setTimeout(() => t.remove(), 400);
  }, 5000);
}

/** Stop a pane's recording (flush the file) and reset its UI. Safe to call when
 *  not recording. Returns the finished recording's path (or null). */
async function stopRecording(p: Pane): Promise<string | null> {
  const path = p.recording;
  if (!path) return null;
  p.recording = undefined;
  setRecUi(p);
  try {
    await recordStop(p.id);
  } catch {
    /* the agent may already be gone — the file was flushed on drop */
  }
  return path;
}

/** Toggle recording for a pane. Start writes to
 *  `<workspace>/.maestro/recordings/<agent>-<epochms>.jsonl`. */
async function toggleRecord(ws: Workspace, p: Pane): Promise<void> {
  if (p.recording) {
    const path = await stopRecording(p);
    paneToast("Recording saved — click to replay", () => {
      if (path) openReplays(ws, path);
    });
    return;
  }
  if (!p.running) {
    paneToast("Agent isn't running — nothing to record");
    return;
  }
  const dir = ws.dir ?? p.spec.cwd;
  if (!dir) {
    paneToast("Open a project folder before recording");
    return;
  }
  const safe = (p.spec.name || "agent").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40);
  const path = `${dir}/${REC_DIR_REL}/${safe}-${Date.now()}.jsonl`;
  try {
    await recordStart(p.id, path);
    p.recording = path;
    setRecUi(p);
  } catch (e) {
    paneToast(`Couldn't start recording: ${errMsg(e)}`);
  }
}

// (cluster extracted to its own module)
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
  adoptWorkspace(payload);
}

/** Rebuild a workspace from a hand-off payload: re-attach to still-running
 *  agents (`pty_attach`, backend replays scrollback) and park stopped ones —
 *  exactly like a session restore. Shared by detach boot + merge-back. */
function adoptWorkspace(payload: DetachPayload) {
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
// getRecents / addRecent / renderRecents live in recents.ts.

// (cluster extracted to its own module)
/* ---------------- home + workspace triggers ---------------- */

document.getElementById("btnNewWorkspace")?.addEventListener("click", () => openWizard());
document.getElementById("btnNewAgent")?.addEventListener("click", () => openModal("current"));
document.getElementById("btnTidy")?.addEventListener("click", () => { if (activeWs) tidyLayout(activeWs); });
configurePaneLayout({ updateBcast, saveSession });
configureBroadcast({ getActiveWs: () => activeWs });
initBroadcast();
configureRecents({ openWizard });
configureUsage({ getActiveWs: () => activeWs, closeSettings });
initUsage();
configureReplay({ paneToast, errMsg, closeSettings });
initReplay();
configureDashboard({ errMsg });
initDashboard();
configureSpawnModal({ createAgent, createWorkspace, cliLook, confirmModal, isPresetAvailable, refreshCliAvailability, conductorLaws: CONDUCTOR_LAWS });
configureWizard({ loadCrew, spawnCrew, loadTemplates, saveTemplates, templateSummary, confirmModal, renderCrew });
configureSession({ createWorkspace, createAgent });
configureScheduler({ closeSettings, loadTemplates, launchPreset });
initSpawnModal();
initWizard();
initSettingsModal();
initScheduler();
tabAdd?.addEventListener("click", () => openWizard());

document.getElementById("btnHome")?.addEventListener("click", goHome);
document.getElementById("homeResume")?.addEventListener("click", resumeWorkspace);
document.getElementById("btnResumeAll")?.addEventListener("click", () => void resumeAllStopped());

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

/* ---------------- Tool dock (Kanban / Pomodoro / Diff) ---------------- */
// No workspace is active yet at init; session restore (below) activates one and
// activateWorkspace() re-scopes the dock to its folder.
initDock();
dockSetContext(null);

/* ---------------- Side panels (project rail resize + code panel) ---------------- */
// The editor is created first so the tree's onOpenFile can hand files to it.
initPanels();
const editor = initEditor({
  host: document.getElementById("editorHost") as HTMLElement,
  getRoot: () => activeWs?.dir ?? null,
});
fileTree = initFileTree({
  host: document.getElementById("fileTree") as HTMLElement,
  onOpenFile: (rel) => void editor.open(rel),
});
// Let the board reveal an evidence file in the code panel, or open the diff.
setFileOpener((path) => {
  appEl.classList.remove("code-hidden");
  localStorage.setItem("maestro.codeHidden", "0");
  document.getElementById("btnToggleCode")?.classList.add("on");
  void editor.open(path);
});
setDiffOpener(() => dockOpen("diff"));

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

/* ---------------- broadcast input ---------------- */
// The broadcast console lives in broadcast.ts; wired up in the startup block.

/* ---------------- keyboard shortcuts ---------------- */
// Windows-Terminal-ish chords, chosen to avoid keys the CLIs themselves use
// (no bare Ctrl+letter). All shortcuts are inert while a modal/wizard is open.
//   Alt+1..9            focus the nth pane (DOM order) of the active workspace
//   Ctrl+Tab            next workspace tab (cycles)
//   Ctrl+Shift+Tab      previous workspace tab (cycles)
//   Ctrl+Shift+T        open the new-workspace wizard
//   Ctrl+Shift+F        toggle the find bar of the focused pane
//   Ctrl+Shift+B        focus the broadcast input

/** Cycle the active workspace tab by ±1 (wraps). Only meaningful in app view. */
function cycleWorkspace(dir: 1 | -1) {
  const list = [...workspaces.values()];
  if (list.length < 2 || !activeWs) return;
  const i = list.indexOf(activeWs);
  if (i < 0) return;
  activateWorkspace(list[(i + dir + list.length) % list.length]);
}

/** The pane whose terminal currently holds focus (xterm focuses a textarea
 *  inside .pane); falls back to the active workspace's first pane. */
function focusedPane(): Pane | null {
  if (!activeWs) return null;
  const host = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".pane");
  if (host) {
    for (const p of activeWs.panes.values()) if (p.el === host) return p;
  }
  return activeWs.panes.values().next().value ?? null;
}

document.addEventListener("keydown", (e) => {
  // Any open backdrop (spawn / wizard / confirm / settings) swallows shortcuts.
  if (document.querySelector(".backdrop.open")) return;

  // Alt+1..9 → focus that pane (no other modifiers).
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code.startsWith("Digit")) {
    const n = Number(e.code.slice(5));
    if (n >= 1 && n <= 9 && activeWs) {
      const pane = [...activeWs.panes.values()][n - 1];
      if (pane) {
        e.preventDefault();
        pane.term.focus();
      }
    }
    return;
  }

  if (!e.ctrlKey || e.metaKey || e.altKey) return;

  // Ctrl+Tab / Ctrl+Shift+Tab → cycle tabs (only when the app view is showing).
  if (e.key === "Tab") {
    if (!appEl.hidden) {
      e.preventDefault();
      cycleWorkspace(e.shiftKey ? -1 : 1);
    }
    return;
  }

  if (!e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k === "t") {
    e.preventDefault();
    openWizard();
  } else if (k === "f") {
    e.preventDefault();
    focusedPane()?.toggleFind?.();
  } else if (k === "b") {
    e.preventDefault();
    focusBroadcast();
  } else if (k === "k") {
    e.preventDefault();
    dockToggle("kanban");
  } else if (k === "j") {
    e.preventDefault();
    dockToggle("pomodoro");
  } else if (k === "d") {
    e.preventDefault();
    dockToggle("diff");
  } else if (k === "l") {
    e.preventDefault();
    dockToggle("fleet");
  }
});

/* ---------------- attention ---------------- */
// Heuristic "agent needs you": a RUNNING pane that produced output recently and
// then went silent is probably waiting at a prompt for the user. We flag it,
// light up the pill + tab, and (if the window is in the background) fire one OS
// notification. The flag clears when the user types/clicks into the pane or the
// agent starts producing output again. attentionClearedAt stops a quiet shell
// prompt from re-flagging forever: only a NEW burst of output (after the clear)
// that then goes silent can flag again.
const ATTN_SILENCE_MS = 10_000; // output, then this much quiet ⇒ probably waiting

/** Drop a pane's attention flag and restore its normal pill/tab styling. */
function clearAttention(pane: Pane) {
  if (!pane.attention) return;
  pane.attention = false;
  pane.attentionNotified = false;
  pane.attentionClearedAt = Date.now();
  pane.el.classList.remove("attention");
  // Let the next tick re-derive the run/idle status; set a sane default now.
  setStatus(pane, pane.running ? "running" : "idle", pane.running ? "run" : "");
  refreshAttnTabs();
}

/** Raise a pane's attention flag (pill + tab + optional OS notification). */
function setAttention(pane: Pane, ws: Workspace) {
  if (pane.attention) return;
  pane.attention = true;
  pane.el.classList.add("attention");
  setStatus(pane, "needs you", "wait");
  refreshAttnTabs();
  // Notify only while the window is unattended, once per flag.
  if (!pane.attentionNotified && (document.hidden || !document.hasFocus())) {
    pane.attentionNotified = true;
    void notify(`${pane.spec.name} needs you`, ws.name).catch(() => {});
  }
}

/** Tab dot turns amber when any of its panes is asking for attention. */
function refreshAttnTabs() {
  for (const w of workspaces.values()) {
    const want = [...w.panes.values()].some((p) => p.attention);
    w.tabEl.classList.toggle("attn", want);
  }
}

/** Per-tick attention sweep. Cheap no-op when nothing is running. */
function updateAttention(now: number) {
  for (const w of workspaces.values())
    for (const pane of w.panes.values()) {
      if (!pane.running || pane.attention) continue;
      // Flag when: had output, that output is now stale, and it arrived AFTER
      // both the last user input and the last clear (so a parked prompt that
      // we already dismissed can't immediately re-flag).
      if (
        pane.lastOutputAt > 0 &&
        now - pane.lastOutputAt > ATTN_SILENCE_MS &&
        pane.lastOutputAt > pane.lastInputAt &&
        pane.lastOutputAt > pane.attentionClearedAt
      ) {
        setAttention(pane, w);
      }
    }
}

/* ---------------- clock ---------------- */
const clk = document.getElementById("clock");
function tick() {
  const d = new Date();
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  if (clk) clk.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  // Live uptime + active/idle activity on every running pane, across all workspaces.
  const now = Date.now();
  updateAttention(now);
  for (const w of workspaces.values())
    for (const pane of w.panes.values()) {
      if (pane.running && pane.spawnedAt != null) {
        const u = pane.el.querySelector<HTMLElement>("[data-uptime]");
        if (u) u.textContent = fmtUptime(now - pane.spawnedAt);
        if (pane.attention) continue; // the pill is owned by the attention flag
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

/* ---------------- block WebView2 browser zoom ---------------- */
// Maestro has its own terminal font-size control (Settings → terminal font
// size), so WebView2's built-in browser zoom is pure footgun here: Ctrl+scroll
// scales the whole page, and xterm's DOM renderer caches glyph metrics at the
// zoomed scale. Clicking WebView2's "Reset" toast snaps zoom back to 100% but
// the cached cell geometry is stale, so every pane renders blank/off-screen
// until a full reflow (the "zoom out → Reset → panes vanish" bug). Cancel the
// zoom gestures before WebView2 acts on them: Ctrl+wheel (the actual trigger of
// the bug) plus the Ctrl +/-/0 keyboard accelerators.
addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) e.preventDefault();
  },
  { passive: false },
);
addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && ["+", "-", "=", "0"].includes(e.key)) {
    e.preventDefault();
  }
});

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
// `agent` swaps the pane's drop label from "attach path" to "send task": a
// Kanban card being dragged onto the pane, not a file.
let dropAgent = false;
function setDropTarget(p: Pane | null, agent = false) {
  if (p === dropTarget && agent === dropAgent) return;
  dropTarget?.el.classList.remove("drop-target", "drop-agent");
  dropTarget = p;
  dropAgent = agent;
  if (p) {
    p.el.classList.add("drop-target");
    if (agent) p.el.classList.add("drop-agent");
  }
}
/** Type whitespace-quoted path(s) into a pane's PTY, then focus it. Shared by
 *  the OS file-drop (paths from outside the app) and the in-app file-tree drag. */
function dropPathsIntoPane(target: Pane, paths: string[]) {
  if (paths.length === 0) return;
  const text = paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ") + " ";
  void sendInput(target.id, text).catch(() => {});
  target.term.focus();
}

/* ---- active agent target (for the Kanban plan bridge) ---- */
// Track the last pane the user interacted with so "Plan with AI" / "Send
// approved" type into the agent they're looking at (else the first pane).
let lastFocusedPaneId: string | null = null;
wsHost.addEventListener(
  "pointerdown",
  (e) => {
    const pane = (e.target as HTMLElement)?.closest<HTMLElement>(".pane");
    if (pane?.dataset.id) lastFocusedPaneId = pane.dataset.id;
  },
  true,
);
// Type into the focused agent of the active workspace (Enter when `submit`).
setAgentSender((text, submit) => {
  if (!activeWs || activeWs.panes.size === 0) return false;
  const id =
    lastFocusedPaneId && activeWs.panes.has(lastFocusedPaneId)
      ? lastFocusedPaneId
      : activeWs.panes.keys().next().value;
  const pane = id ? activeWs.panes.get(id) : undefined;
  if (!pane) return false;
  void sendInput(pane.id, text + (submit ? "\r" : "")).catch(() => {});
  pane.term.focus();
  return true;
});
// Kanban card → pane: highlight the pane under the pointer while a card is being
// dragged, and drop the card's task into that pane's PTY (no Enter) on release.
// Pointer events give client CSS px, so resolve with paneAtClient (no DPR).
setPaneTargeting({
  hover: (x, y) => {
    const p = paneAtClient(x, y);
    setDropTarget(p, true);
    return !!p;
  },
  clear: () => setDropTarget(null),
  drop: (x, y, text) => {
    const target = paneAtClient(x, y) ?? dropTarget;
    setDropTarget(null);
    if (!target || !text) return null;
    void sendInput(target.id, text).catch(() => {});
    target.term.focus();
    return { id: target.id, name: target.spec.name, color: target.color, running: target.running };
  },
});
// Fleet directory for the board: running panes of the active workspace.
setFleet(() =>
  activeWs
    ? [...activeWs.panes.values()].map((p) => ({
        id: p.id,
        name: p.spec.name,
        color: p.color,
        running: p.running,
      }))
    : [],
);
setAgentSenderById((id, text, submit) => {
  const pane = activeWs?.panes.get(id);
  if (!pane || !pane.running) return false;
  void sendInput(pane.id, text + (submit ? "\r" : "")).catch(() => {});
  pane.term.focus();
  return true;
});
setPaneFocuser((id) => {
  const pane = activeWs?.panes.get(id);
  if (!pane) return false;
  pane.term.focus();
  pane.el.scrollIntoView({ block: "nearest" });
  return true;
});
// Fleet monitor: a snapshot of every pane in every workspace, and a reveal
// action that switches to the owning workspace tab before focusing the pane.
setFleetSnapshot(() => {
  const out: FleetPane[] = [];
  for (const ws of workspaces.values())
    for (const p of ws.panes.values())
      out.push({
        id: p.id,
        name: p.spec.name,
        color: p.color,
        wsId: ws.id,
        wsName: ws.name,
        running: p.running,
        attention: p.attention,
        spawnedAt: p.spawnedAt,
        lastOutputAt: p.lastOutputAt,
      });
  return out;
});
setPaneRevealer((wsId, paneId) => {
  const ws = workspaces.get(wsId);
  const pane = ws?.panes.get(paneId);
  if (!ws || !pane) return false;
  if (ws !== activeWs) activateWorkspace(ws);
  pane.term.focus();
  pane.el.scrollIntoView({ block: "nearest" });
  return true;
});

// Fleet file-bridge: publish each workspace's roster to .maestro/fleet.json and
// deliver messages the maestro-mcp `fleet_send` tool drops into outbox.jsonl.
initFleetBridge({
  workspaces: () => {
    const now = Date.now();
    const out = [];
    for (const ws of workspaces.values()) {
      if (!ws.dir) continue;
      out.push({
        dir: ws.dir,
        name: ws.name,
        agents: [...ws.panes.values()].map((p) => ({
          id: p.id,
          name: p.spec.name,
          status: paneStatus(
            {
              id: p.id,
              name: p.spec.name,
              color: p.color,
              wsId: ws.id,
              wsName: ws.name,
              running: p.running,
              attention: p.attention,
              spawnedAt: p.spawnedAt,
              lastOutputAt: p.lastOutputAt,
            },
            now,
          ),
          // Recent on-screen text so an agent (a conductor) can read a worker's
          // progress via the MCP agent_output tool. Capped for the file.
          screen: p.term.snapshot(40).slice(-2000),
        })),
      });
    }
    return out;
  },
  deliver: (dir, to, message) => {
    const ws = [...workspaces.values()].find((w) => w.dir === dir);
    if (!ws) return;
    const targets = to
      ? [...ws.panes.values()].filter((p) => p.running && p.spec.name === to)
      : [...ws.panes.values()].filter((p) => p.running);
    for (const p of targets) void sendInput(p.id, message + "\r").catch(() => {});
  },
  spawn: (dir, req) => void spawnForConductor(dir, req),
});
void onDragDrop((e) => {
  if (e.type === "leave") return setDropTarget(null);
  if (e.type === "enter" || e.type === "over") {
    return setDropTarget(paneAtPoint(e.position.x, e.position.y));
  }
  // drop: type the (whitespace-quoted) path(s) into the targeted pane's PTY.
  const target = paneAtPoint(e.position.x, e.position.y) ?? dropTarget;
  setDropTarget(null);
  if (target) dropPathsIntoPane(target, e.paths);
});

/* ---- in-app drag: a file-tree row → a terminal pane (HTML5 DnD) ---- */
// Tauri's onDragDrop only fires for files dragged from OUTSIDE the window, so
// tree-row drags use plain HTML5 DnD. `body.tree-dragging` lets dragover reach
// the panes (the xterm canvas otherwise swallows pointer events).
const TREE_PATH = "application/x-maestro-path";
/** Pane under a CSS-pixel point (HTML5 client coords need no DPR scaling). */
function paneAtClient(x: number, y: number): Pane | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".pane");
  const id = el?.dataset.id;
  return id && activeWs ? activeWs.panes.get(id) ?? null : null;
}
wsHost.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types.includes(TREE_PATH)) return; // not a tree drag
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  setDropTarget(paneAtClient(e.clientX, e.clientY));
});
wsHost.addEventListener("dragleave", (e) => {
  if (e.dataTransfer?.types.includes(TREE_PATH) && !wsHost.contains(e.relatedTarget as Node)) {
    setDropTarget(null);
  }
});
wsHost.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.types.includes(TREE_PATH)) return;
  e.preventDefault();
  const abs = e.dataTransfer.getData(TREE_PATH) || e.dataTransfer.getData("text/plain");
  const target = paneAtClient(e.clientX, e.clientY) ?? dropTarget;
  setDropTarget(null);
  if (target && abs) dropPathsIntoPane(target, [abs]);
});

/* pty-exit listener LAST + guarded so it can never block the wiring above. */
onExit((id, code) => {
  for (const w of workspaces.values()) {
    const p = w.panes.get(id);
    if (p) {
      p.running = false;
      p.spawnedAt = null;
      clearAttention(p); // a dead agent isn't waiting on anyone
      if (p.recording) void stopRecording(p); // flush + close the recording
      setStatus(p, `exited (${code})`, "");
      updateCount();
      break;
    }
  }
}).catch((e) => console.warn("pty-exit listener unavailable:", e));

// (cluster extracted to its own module)
/* ---------------- session replay player ---------------- */
// Lives in replay.ts (openReplays + player); wired up in the startup block.


/* ---------------- token usage & cost ---------------- */
// Lives in usage.ts (openUsage + modal); wired up in the startup block.

/* ---------------- local web dashboard (remote fleet view) ---------------- */
// Lives in dashboard.ts; started from the startup block.

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

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const allWindows = await WebviewWindow.getAll();
  let visibleCount = 0;
  for (const w of allWindows) {
    if (await w.isVisible()) visibleCount++;
  }

  // If this is the last visible window, quit the app completely.
  if (visibleCount <= 1) {
    await quitApp();
    return;
  }

  // Otherwise, just close THIS window.
  if (isDetachedWindow) {
    await closeDetachedWindow();
  } else {
    // The main window is closing, but detached windows are still active.
    // We shouldn't destroy the main window (breaks the tray icon).
    // Just kill its PTYs, clear workspaces, and hide it.
    const total = ownPaneCount();
    if (needsCloseConfirm(total)) {
      const ok = await confirmDialog(`${total} running terminal(s) will be killed. Close this window?`, "Close window");
      if (!ok) return;
    }
    closing = true;
    for (const w of workspaces.values()) {
      for (const id of w.panes.keys()) {
        try { await killPty(id); } catch {}
      }
    }
    workspaces.clear();
    saveSession();
    await hideWindow();
    closing = false;
  }
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
