// Outbound cross-window workspace handoff: snapshot a workspace into a payload,
// tear it out into a brand-new Maestro window (detach), or fold it back into the
// main window (merge). Running agents are NEVER killed — they keep running in the
// backend and the receiving window re-attaches to their PTYs. Split from
// workspace.ts; the inbound side (adopt/boot) stays there next to createWorkspace.
// `dropWorkspace` (drop the tab locally, refocus) lives in workspace.ts and is
// imported here — a runtime-only circular import (all calls happen in handlers).

import { destroyWindow, openDetachWindow, onAppEvent, emitAppEvent } from "./ipc";
import { type Workspace, type AgentSpec } from "./panetypes";
import { workspaces } from "./appstate";
import { dropWorkspace } from "./workspace";

// Hand-off payload written to localStorage (shared across this app's windows)
// and consumed once by the new window's boot path.
export interface DetachAgent {
  spec: AgentSpec;
  id: string;
  running: boolean;
  spawnedAt: number | null;
}
export interface DetachPayload {
  name: string;
  dir: string | null;
  repoRoot: string | null;
  isolated: boolean;
  agents: DetachAgent[];
}

// The mirror of detach: a workspace in a DETACHED window can be folded BACK into
// the main window. We use Tauri's app-global event bus (emit/listen) with an ack
// handshake — the detached window only releases the tab once the main window
// confirms it adopted it, so the workspace is never dropped if the main window
// is gone (then we fall back to leaving the tab / detaching into a new window).
export const MERGE_EVT = "maestro://merge";
export const MERGE_ACK_EVT = "maestro://merge-ack";
export interface MergeMsg {
  key: string;
  ws: DetachPayload;
}

/** Snapshot a workspace into a hand-off payload (running agents are referenced
 *  by id so the receiver can re-attach via `pty_attach`; stopped ones stay
 *  parked). Shared by detach (→ new window) and merge-back (→ main window). */
export function buildDetachPayload(ws: Workspace): DetachPayload {
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
export async function detachWorkspace(ws: Workspace) {
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

/** Detached-window side: hand `ws` back to the main window and (on success)
 *  release the tab here. Returns false if the main window never acked within the
 *  timeout (closed / not listening) — caller then leaves the tab untouched. */
export async function mergeWorkspaceToMain(ws: Workspace): Promise<boolean> {
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
