// Workspace (project) lifecycle: create, activate, rename and remove a project,
// and adopt one handed over from another Maestro window. Split from
// main.ts; pane creation/removal and the Home⇄Workspace view toggles are
// injected via configureWorkspace to avoid a circular import (they live in
// main.ts's own pane-lifecycle cluster).

import {
  onAppEvent,
  emitAppEvent,
  focusThisWindow,
} from "./ipc";
import { parseLayout } from "./canvas";
import { type Workspace, type AgentSpec } from "./panetypes";
import { layoutGrid } from "./panelayout";
import { saveSession } from "./session";
import { workspaces, activeWs, setActiveWs, nextWsId } from "./appstate";
import { nextWorkspaceName, pickNextActive, sameFolder } from "./workspaces";
import { dockSetContext } from "./dock";
import { confirmModal } from "./confirmmodal";
import {
  MERGE_EVT,
  MERGE_ACK_EVT,
  type DetachPayload,
  type MergeMsg,
} from "./windetach";

let onCreateAgent: (
  ws: Workspace,
  spec: AgentSpec,
  restore?: boolean,
  attach?: { id: string; spawnedAt: number | null },
) => () => Promise<void> = () => async () => {};
let onRemoveAgent: (ws: Workspace, id: string) => Promise<void> = async () => {};
let onUpdateCount: () => void = () => {};
let onShowWorkspace: () => void = () => {};
let onShowView: () => void = () => {};
let onSyncResumeAll: () => void = () => {};
let onSetFileTreeRoot: (dir: string | null) => void = () => {};
let onApplyBackground: (ws: Workspace) => void = () => {};
export function configureWorkspace(deps: {
  createAgent: (
    ws: Workspace,
    spec: AgentSpec,
    restore?: boolean,
    attach?: { id: string; spawnedAt: number | null },
  ) => () => Promise<void>;
  removeAgent: (ws: Workspace, id: string) => Promise<void>;
  updateCount: () => void;
  showWorkspace: () => void;
  showView: () => void;
  syncResumeAll: () => void;
  setFileTreeRoot: (dir: string | null) => void;
  applyBackground: (ws: Workspace) => void;
}): void {
  onCreateAgent = deps.createAgent;
  onRemoveAgent = deps.removeAgent;
  onUpdateCount = deps.updateCount;
  onShowWorkspace = deps.showWorkspace;
  onShowView = deps.showView;
  onSyncResumeAll = deps.syncResumeAll;
  onSetFileTreeRoot = deps.setFileTreeRoot;
  onApplyBackground = deps.applyBackground;
}

// A detached window (a tab dragged out of another Maestro window) boots with
// ?detach=<key> pointing at its localStorage hand-off payload. Mirrors main.ts's
// own DETACH_KEY/isDetachedWindow (computed independently — both read the same
// URL, so they always agree).
const DETACH_KEY = new URLSearchParams(location.search).get("detach");
const isDetachedWindow = DETACH_KEY !== null;

const wsHost = document.getElementById("workspaces") as HTMLElement;
export function createWorkspace(dir: string | null, name?: string): Workspace {
  // One project per folder: a folder already open is that project.
  const open = dir ? [...workspaces.values()].find((w) => sameFolder(w.dir, dir)) : undefined;
  if (open) { activateWorkspace(open); return open; }
  const id = nextWsId();
  // A restored tab passes its original name; otherwise auto-name it.
  const wsName = name ?? nextWorkspaceName(dir, [...workspaces.values()].map((w) => w.name));

  const gridEl = document.createElement("div");
  gridEl.className = "grid canvas";
  wsHost.appendChild(gridEl);

  const ws: Workspace = { id, name: wsName, dir, repoRoot: null, isolated: false, gridEl, panes: new Map(), layout: new Map(Object.entries(parseLayout(localStorage.getItem(`maestro.canvas.${dir ?? id}`)))) };
  workspaces.set(id, ws);
  activateWorkspace(ws);
  layoutGrid(ws);
  saveSession();
  return ws;
}

export function activateWorkspace(ws: Workspace) {
  setActiveWs(ws);
  for (const w of workspaces.values()) {
    w.gridEl.hidden = w !== ws;
  }
  onShowWorkspace();
  onSyncResumeAll(); // the newly-active tab may have its own parked panes
  // Re-scope the tool dock (board / timer / diff) to this workspace's folder.
  dockSetContext({ key: ws.dir || ws.id, dir: ws.dir });
  // Re-root the code panel's file tree to this workspace's folder.
  onSetFileTreeRoot(ws.dir);
  // Paint this workspace's saved canvas background.
  onApplyBackground(ws);
}


/** Rename a project. */
export function renameWorkspace(ws: Workspace, name: string): void {
  const v = name.trim();
  if (!v) return;
  ws.name = v;
  saveSession();
}

/* ---------------- drop a workspace locally ---------------- */

/** Remove a (already emptied) workspace's DOM + map entry and refocus. Shared
 *  by close (panes killed first) and detach/merge (panes handed off first, in
 *  windetach.ts, which imports this). Exported for that cross-window handoff. */
export function dropWorkspace(ws: Workspace) {
  const nextId = pickNextActive([...workspaces.keys()], ws.id);
  ws.gridEl.remove();
  workspaces.delete(ws.id);
  if (activeWs === ws) {
    const next = nextId ? workspaces.get(nextId) ?? null : null;
    if (next) activateWorkspace(next);
    else {
      setActiveWs(null);
      onShowView();
    }
  }
  onUpdateCount();
  saveSession();
}

// Cross-window drag counter: how many workspace drags are currently hovering
// this window's body (drives the .drag-over-ws drop hint). Shared by the tab
// drop handler and the body-level listeners in initWorkspace.
let dragWsCount = 0;

const SKIP_WS_CLOSE = "maestro.skipWsCloseConfirm";
export async function removeWorkspace(ws: Workspace) {
  if (ws.panes.size > 0 && localStorage.getItem(SKIP_WS_CLOSE) !== "1") {
    const { ok, dontAsk } = await confirmModal({
      title: "Close project",
      message: `Close "${ws.name}"? Its ${ws.panes.size} agent${ws.panes.size === 1 ? "" : "s"} will be stopped.`,
      okLabel: "Close project",
      dontAsk: true,
    });
    if (!ok) return;
    if (dontAsk) localStorage.setItem(SKIP_WS_CLOSE, "1");
  }
  for (const id of [...ws.panes.keys()]) await onRemoveAgent(ws, id);
  dropWorkspace(ws);
}

/* ---------------- detached-window boot ---------------- */
// Consume the hand-off payload written by detachWorkspace() in the original
// window: rebuild the workspace, re-attach to the still-running agents, and
// park the stopped ones exactly like a session restore.
export function bootDetached(key: string) {
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
      void onCreateAgent(ws, a.spec, false, { id: a.id, spawnedAt: a.spawnedAt ?? null })();
    } else {
      onCreateAgent(ws, a.spec, true); // was stopped — stays parked
    }
  }
}

/** Wire the document/body-level drag listeners that support cross-window tab
 *  drag (window enter/leave tracking, the drop-anywhere-in-body fallback, and
 *  the main-window-side merge-back listener). Call once at startup. */
export function initWorkspace(): void {
  // Main-window side: adopt any workspace another window asks us to merge in, ack
  // it (keyed so the sender knows which request completed), and surface ourselves.
  if (!isDetachedWindow) {
    void onAppEvent<MergeMsg>(MERGE_EVT, (m) => {
      adoptWorkspace(m.ws);
      void emitAppEvent(MERGE_ACK_EVT, { key: m.key });
      void focusThisWindow().catch(() => {});
    });
  }

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
}
