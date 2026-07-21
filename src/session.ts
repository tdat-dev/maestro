// Session persistence: serialize every workspace + its agents' launch specs so
// the next launch can restore the same tabs (as STOPPED panes). Split from
// main.ts; workspace/agent creation is injected to avoid a circular import —
// restoring must recreate both to rebuild the saved tabs.

import { workspaces } from "./appstate";
import { type AgentSpec, type Workspace } from "./panetypes";

// A detached window (a tab dragged out of another Maestro window) boots with
// ?detach=<key> pointing at its localStorage hand-off payload. Mirrors main.ts's
// own DETACH_KEY/isDetachedWindow (computed independently — both read the same
// URL, so they always agree).
const DETACH_KEY = new URLSearchParams(location.search).get("detach");
const isDetachedWindow = DETACH_KEY !== null;

let createWorkspace: (dir: string | null, name?: string) => Workspace = () => {
  throw new Error("session: createWorkspace not configured");
};
let createAgent: (ws: Workspace, spec: AgentSpec, restore?: boolean) => unknown = () => {};
export function configureSession(deps: {
  createWorkspace: (dir: string | null, name?: string) => Workspace;
  createAgent: (ws: Workspace, spec: AgentSpec, restore?: boolean) => unknown;
}): void {
  createWorkspace = deps.createWorkspace;
  createAgent = deps.createAgent;
}

// Detached windows save under their own key: if the whole app quits while they
// are open, the next launch's main window sweeps those keys back into tabs.
const SESSION_KEY = "maestro.session";
const DETACH_SESSION_PREFIX = "maestro.session.detach.";
export const sessionKey = isDetachedWindow ? DETACH_SESSION_PREFIX + DETACH_KEY : SESSION_KEY;

// Cheap, called on any set change.
export function saveSession(): void {
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
export function detachedSessionCount(): number {
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

/** Restore the previous session: the main window's own tabs, plus any leftover
 *  detached-window sessions (the app quit/crashed while they were open). The
 *  user resumes any pane via its ⟳ button. No-op when there's nothing saved.
 *  Call once at startup. */
export function restoreSession(): void {
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
