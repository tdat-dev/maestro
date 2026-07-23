// Shared, mutable app state — split out so feature modules can read/refresh the
// active workspace and mint ids without importing back into main.ts. `activeWs`
// is exported as a live ES-module binding: importers always see the current
// value; only setActiveWs may reassign it.

import { type Workspace } from "./panetypes";

/** Every open workspace, keyed by id. */
export const workspaces = new Map<string, Workspace>();

/** The workspace whose canvas is currently shown (null on Home). */
export let activeWs: Workspace | null = null;
export function setActiveWs(ws: Workspace | null): void {
  activeWs = ws;
}

let counter = 0;
/** A fresh agent id, unique across HMR reloads too, so it never collides with a
 *  still-running backend agent from a previous frontend session. */
export function newId(): string {
  counter += 1;
  return `agent-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

let wsCounter = 0;
/** A fresh workspace id. */
export function nextWsId(): string {
  wsCounter += 1;
  return `ws-${wsCounter}`;
}
