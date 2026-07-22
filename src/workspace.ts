// Workspace/tab lifecycle: create/activate/remove a workspace tab, pane search
// (find in output), tab drag-reorder + rename, tab detach into a new Maestro
// window, and merging a detached tab back into the main window. Split from
// main.ts; pane creation/removal and the Home⇄Workspace view toggles are
// injected via configureWorkspace to avoid a circular import (they live in
// main.ts's own pane-lifecycle cluster).

import {
  destroyWindow,
  onAppEvent,
  emitAppEvent,
  focusThisWindow,
} from "./ipc";
import { parseLayout } from "./canvas";
import { type Workspace, type AgentSpec } from "./panetypes";
import { layoutGrid } from "./panelayout";
import { updateBcast } from "./broadcast";
import { saveSession } from "./session";
import { workspaces, activeWs, setActiveWs, nextWsId } from "./appstate";
import { nextWorkspaceName, pickNextActive } from "./workspaces";
import { dockSetContext } from "./dock";
import { openModal } from "./spawnmodal";
import { confirmModal } from "./confirmmodal";
import {
  buildDetachPayload,
  detachWorkspace,
  mergeWorkspaceToMain,
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
// The project rail replaces the old horizontal tab strip. `railList` holds the
// `.proj` rows; the old `tabstrip` name is kept as an alias so the rest of the
// workspace logic (drag, order, rename) stays untouched.
const railList = document.getElementById("railList") as HTMLElement;
const tabstrip = railList;

// Shared with the pane-lifecycle module — kept as a local duplicate (a pure
// SVG string constant) so this module doesn't need to import back into main.
const KILL_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const SPAWN_TILE_SVG =
  '<span class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span><span class="t">Spawn agent</span><span class="sub">real ConPTY · type · tree-kill</span>';

export function createWorkspace(dir: string | null, name?: string): Workspace {
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

  const ws: Workspace = { id, name: wsName, dir, repoRoot: null, isolated: false, gridEl, tabEl, panes: new Map(), layout: new Map(Object.entries(parseLayout(localStorage.getItem(`maestro.canvas.${dir ?? id}`)))) };
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

export function activateWorkspace(ws: Workspace) {
  setActiveWs(ws);
  for (const w of workspaces.values()) {
    w.gridEl.hidden = w !== ws;
    w.tabEl.classList.toggle("active", w === ws);
  }
  onShowWorkspace();
  updateBcast();
  onSyncResumeAll(); // the newly-active tab may have its own parked panes
  // Re-scope the tool dock (board / timer / diff) to this workspace's folder.
  dockSetContext({ key: ws.dir || ws.id, dir: ws.dir });
  // Re-root the code panel's file tree to this workspace's folder.
  onSetFileTreeRoot(ws.dir);
  // Paint this workspace's saved canvas background.
  onApplyBackground(ws);
}


/* ---------------- pane drag-reorder ---------------- */
// Header is the drag handle; dropping over another pane live-reorders the DOM,
// and the new order is committed back into ws.panes (+ persisted) on dragend.
// Free-position a pane by dragging its title bar (Pointer Events — WebView2
// breaks HTML5 DnD). Updates the workspace canvas layout live and persists on
// release. A near-zero drag is treated as a click (leaves focus handling alone).
// (actual pane free-drag lives in panelayout.ts — wirePaneDrag)
/* ---------------- tab drag (reorder / detach) + rename ---------------- */
// The whole tab is the drag handle. Dragging over a sibling live-reorders the
// strip (committed + persisted on dragend); releasing OUTSIDE the window
// detaches the workspace into a brand-new Maestro window (agents keep running).
let tabDragSrc: Workspace | null = null;
// Whether the drag pointer is currently over THIS window. dragend's
// coordinates alone are unreliable for out-of-window drops in WebView2, so we
// also track window enter/leave during the drag (leave → relatedTarget null).
let tabDragInside = true;
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

/* ---------------- drop a workspace tab locally ---------------- */

/** Remove a (already emptied) workspace's DOM + map entry and refocus. Shared
 *  by close (panes killed first) and detach/merge (panes handed off first, in
 *  windetach.ts, which imports this). Exported for that cross-window handoff. */
export function dropWorkspace(ws: Workspace) {
  const nextId = pickNextActive([...workspaces.keys()], ws.id);
  ws.gridEl.remove();
  ws.tabEl.remove();
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
      title: "Close workspace",
      message: `Close "${ws.name}"? Its ${ws.panes.size} terminal(s) will be killed.`,
      okLabel: "Close workspace",
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
  document.addEventListener("dragenter", () => {
    if (tabDragSrc) tabDragInside = true;
  });
  document.addEventListener("dragleave", (e) => {
    if (tabDragSrc && e.relatedTarget === null) tabDragInside = false;
  });

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
