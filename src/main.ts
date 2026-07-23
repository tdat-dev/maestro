// Styles are loaded via a render-blocking <link> in index.html (not imported
// here) so the first paint is fully styled — see the note in index.html.
import { resizePty, killAll, setTrayTooltip } from "./ipc";
import { CLI_PRESETS } from "./crew";
import { type Pane } from "./panetypes";
import { configurePaneLayout, tidyLayout } from "./panelayout";
import { configureBroadcast, initBroadcast, updateBcast, focusBroadcast } from "./broadcast";
import { configureRecents, getRecents, renderRecents } from "./recents";
import { configureUsage, initUsage } from "./usage";
import { configureReplay, initReplay } from "./replay";
import { configureDashboard, initDashboard } from "./dashboard";
import { configureSpawnModal, initSpawnModal, openModal, spawnCrew, loadCrew, renderCrew, loadTemplates, saveTemplates, templateSummary } from "./spawnmodal";
import { configureSpawnMenu, initSpawnMenu } from "./spawnmenu";
import { configureWizard, initWizard, openWizard, isPresetAvailable, refreshCliAvailability, launchPreset } from "./wizard_ui";
import { closeSettings, initSettingsModal } from "./settingsmodal";
import { configureSession, saveSession, restoreSession } from "./session";
import { configureScheduler, initScheduler } from "./scheduler";
import { configurePane, createAgent, removeAgent, stopRecording, paneToast, setStatus, clearAttention, updateAttention } from "./pane";
import { configureWorkspace, initWorkspace, createWorkspace, activateWorkspace, bootDetached } from "./workspace";
import { confirmModal } from "./confirmmodal";
import { wirePaneSearch } from "./panesearch";
import { initMascotView } from "./mascotview";
import { initVoice } from "./voice";
import { configureBackground, initBackground, applyBackground } from "./background";
import { initTopbarChrome } from "./topbarchrome";
import { initHint, topNote } from "./hint";
import { configureBridges, initBridges } from "./bridges";
import { initQuitLife } from "./quitlife";
import { workspaces, activeWs } from "./appstate";
import { basename } from "./workspaces";
import { checkForUpdates } from "./updater";
import { initTitlebar } from "./titlebar";
import { initIdleAnimationPause } from "./power";
import { initDock, dockSetContext, dockToggle, dockOpen } from "./dock";
import { initPanels } from "./panels";
import { initFileTree, type FileTreeApi } from "./filetree";
import { initEditor } from "./editor";
import { setFileOpener, setDiffOpener } from "./agentbridge";

/* Home launcher ⇄ Workspace grid.
 * Home is shown while there are 0 agents (the prominent "create" entry).
 * Spawning agents switches to the Workspace; closing them all returns Home.
 * Each agent = its own real ConPTY process; closing a pane tree-kills it. */


// No PTY output for this long while alive ⇒ the agent is idle (waiting at a prompt).
const IDLE_MS = 1200;

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

// A detached window (a tab dragged out of another Maestro window) boots with
// ?detach=<key> pointing at its localStorage hand-off payload. It skips the
// main window's app-global duties (kill-all, session restore, tray, updates).
const DETACH_KEY = new URLSearchParams(location.search).get("detach");
const isDetachedWindow = DETACH_KEY !== null;

const homeEl = document.getElementById("home") as HTMLElement;
const appEl = document.getElementById("app") as HTMLElement;
const tabAdd = document.getElementById("railAdd") as HTMLElement;

// Code panel (right): file tree + editor, wired up in the startup block.
let fileTree: FileTreeApi | null = null;

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

// (extracted to its own module)

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

// (extracted to its own module)
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
// (extracted to its own module)

/* ---------------- recent folders ---------------- */
// getRecents / addRecent / renderRecents live in recents.ts.

// (cluster extracted to its own module)
/* ---------------- home + workspace triggers ---------------- */

document.getElementById("btnNewWorkspace")?.addEventListener("click", () => openWizard());
document.getElementById("btnNewAgent")?.addEventListener("click", () => openModal("current"));
document.getElementById("btnTidy")?.addEventListener("click", () => {
  if (!activeWs) return;
  tidyLayout(activeWs);
  const n = activeWs.panes.size;
  topNote(`Tidied ${n} pane${n === 1 ? "" : "s"} into a grid`);
});
configurePaneLayout({ updateBcast, saveSession });
configureBroadcast({ getActiveWs: () => activeWs });
initBroadcast();
initVoice();
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
configurePane({ errMsg, updateCount, showWorkspace, wirePaneSearch });
configureWorkspace({ createAgent, removeAgent, updateCount, showWorkspace, showView, syncResumeAll, setFileTreeRoot: (dir) => fileTree?.setRoot(dir), applyBackground });
configureBackground({ getActiveWs: () => activeWs, toast: paneToast });
configureSpawnMenu({ spawnCrew, isPresetAvailable, refreshCliAvailability });
configureBridges({ activateWorkspace, clearAttention, setStatus, updateCount, stopRecording });
initSpawnModal();
initWizard();
initSettingsModal();
initScheduler();
initWorkspace();
initBackground();
initSpawnMenu();
initTopbarChrome();
initHint();
initMascotView();
initBridges();
initQuitLife();
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

// (extracted to its own module)
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
  // Keep the open tab pointing at the file after a rename/move, and let go of
  // it when the file is deleted from the tree.
  onPathChanged: (from, to) => editor.pathChanged(from, to),
  onPathsGone: (rels) => editor.pathsGone(rels),
  // "Open in terminal here" — a shell pane already parked in that folder.
  onOpenTerminal: (dir) => {
    const ws = activeWs;
    if (!ws) return;
    const ps = CLI_PRESETS.find((p) => p.id === "powershell")!;
    void createAgent(ws, {
      program: ps.program,
      args: ps.args,
      cwd: dir,
      name: basename(dir),
      badge: ps.badge,
      ...cliLook(ps.badge, ps.label),
    })();
  },
});
// Let the board reveal an evidence file in the code panel, or open the diff.
setFileOpener((path) => {
  appEl.classList.remove("code-hidden");
  localStorage.setItem("maestro.codeHidden", "0");
  document.getElementById("btnToggleCode")?.classList.add("on");
  void editor.open(path);
  void fileTree?.reveal(path);
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

// (extracted to its own module)

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

// (extracted to its own module)
/* ---------------- session replay player ---------------- */
// Lives in replay.ts (openReplays + player); wired up in the startup block.


/* ---------------- token usage & cost ---------------- */
// Lives in usage.ts (openUsage + modal); wired up in the startup block.

/* ---------------- local web dashboard (remote fleet view) ---------------- */
// Lives in dashboard.ts; started from the startup block.

// (extracted to its own module)
