// Drag-drop + Kanban-bridge cluster: OS file-drop and in-app file-tree drag
// onto a terminal pane, the agentbridge wiring that lets the Kanban board talk
// to the focused/targeted/fleet-wide panes, and the fleet file-bridge that
// publishes the roster to .maestro/fleet.json for the maestro MCP tools. Split
// out of main.ts; the handful of main-side helpers it calls (workspace switch,
// attention/status bookkeeping, recording stop) are injected via
// configureBridges to avoid a circular import.

import { sendInput, onDragDrop, onExit } from "./ipc";
import { type Pane, type Workspace } from "./panetypes";
import { workspaces, activeWs } from "./appstate";
import {
  setAgentSender,
  setPaneTargeting,
  setFleet,
  setAgentSenderById,
  setPaneFocuser,
  setFleetSnapshot,
  setPaneRevealer,
  type FleetPane,
} from "./agentbridge";
import { initFleetBridge } from "./fleetbridge";
import { spawnForConductor } from "./spawnmodal";
import { paneStatus } from "./fleet";
import { showDelegation } from "./delegation";

const wsHost = document.getElementById("workspaces") as HTMLElement;

let activateWorkspace: (ws: Workspace) => void = () => {};
let clearAttention: (pane: Pane) => void = () => {};
let setStatus: (p: Pane, text: string, cls: "" | "run" | "err" | "wait") => void = () => {};
let updateCount: () => void = () => {};
let stopRecording: (p: Pane) => Promise<string | null> = async () => null;
export function configureBridges(deps: {
  activateWorkspace: (ws: Workspace) => void;
  clearAttention: (pane: Pane) => void;
  setStatus: (p: Pane, text: string, cls: "" | "run" | "err" | "wait") => void;
  updateCount: () => void;
  stopRecording: (p: Pane) => Promise<string | null>;
}): void {
  activateWorkspace = deps.activateWorkspace;
  clearAttention = deps.clearAttention;
  setStatus = deps.setStatus;
  updateCount = deps.updateCount;
  stopRecording = deps.stopRecording;
}

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

const TREE_PATH = "application/x-maestro-path";
/** Pane under a CSS-pixel point (HTML5 client coords need no DPR scaling). */
function paneAtClient(x: number, y: number): Pane | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".pane");
  const id = el?.dataset.id;
  return id && activeWs ? activeWs.panes.get(id) ?? null : null;
}

/** Wire every drag-drop + Kanban-bridge listener/registration. Call once at
 *  startup, after configureBridges. */
export function initBridges(): void {
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
    deliver: (dir, from, to, message) => {
      const ws = [...workspaces.values()].find((w) => w.dir === dir);
      if (!ws) return;
      const targets = to
        ? [...ws.panes.values()].filter((p) => p.running && p.spec.name === to)
        : [...ws.panes.values()].filter((p) => p.running);
      for (const p of targets) void sendInput(p.id, message + "\r").catch(() => {});
      showDelegation(ws, from, targets);
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
}
