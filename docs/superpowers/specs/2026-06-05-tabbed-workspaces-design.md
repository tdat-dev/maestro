# Tabbed Workspaces + Close-Confirm — Design

**Date:** 2026-06-05
**Status:** Approved (design) — pending implementation plan
**Phase:** 2

## Problem

Maestro currently has a single global grid of agent panes. The user wants
Chrome-style **tabs**, where each tab is a separate **workspace** (its own grid
of agent panes), so different crews/folders can be organized into tabs and
switched between. Additionally, closing the app window (X) must **kill every
running terminal**, but only after a **confirmation prompt**.

## Goals

- Multiple workspaces, each a self-contained grid of agent panes, switchable via
  a Chrome-like tab strip.
- Spawning targets the active workspace; "New workspace" / tab "+" creates a new
  tab and spawns into it.
- Closing a tab kills that workspace's agents (confirm if non-empty); closing the
  last workspace returns to Home (does not quit the app).
- Closing the app window prompts for confirmation when terminals are running,
  then tree-kills all of them before quitting.

## Non-Goals

- No drag-to-reorder tabs, no tab rename UI (name derived automatically). 
- No session persistence across app restarts (that is a separate Phase 2 slice).
- No change to the per-pane Mission Control chrome (monogram, uptime, pulse) —
  it is reused unchanged inside each workspace grid.
- No backend (Rust) logic change beyond capability permissions.

## Architecture

### Workspace unit

```ts
interface Workspace {
  id: string;
  name: string;            // dir basename, else "Workspace N"
  dir: string | null;
  gridEl: HTMLElement;     // this workspace's own .grid (with its spawn tile)
  tabEl: HTMLElement;      // its tab in the strip
  panes: Map<string, Pane>;
}
```

State: `workspaces: Map<string, Workspace>` + `activeWs: Workspace | null`. The
current global `panes` map and single `grid` element are replaced by per-
workspace versions. Only the active workspace's grid is shown (`hidden` on the
rest).

Pane operations become workspace-scoped:
- `createAgent` mounts into a given workspace's `gridEl` + `panes`.
- `removeAgent(ws, id)`, `updateCount()` (sums across all workspaces for the
  topbar stats and per-tab counts), the uptime `tick()` iterates every
  workspace's panes, and the `pty-exit` listener locates the pane by scanning
  workspaces for the id.

### Pure helpers (`src/workspaces.ts`, DOM-free, tested)

- `nextWorkspaceName(dir: string | null, takenNames: string[]): string` — dir
  basename, or the first unused `Workspace N`.
- `pickNextActive(ids: string[], closingId: string): string | null` — which
  workspace to activate after closing one (neighbour, else null).
- `runningTotal(counts: number[]): number` and
  `needsCloseConfirm(total: number): boolean` (= `total > 0`).

### Tab strip

A new row between the topbar and the grid area. App becomes a 3-row grid:
`topbar (50px) / tabstrip (40px) / main (1fr)`. The strip holds one `.tab` per
workspace plus a trailing `+` button.

Each tab shows: a live dot (green when the workspace has ≥1 running agent), the
name, a count badge, and a `×` close button. The active tab is highlighted
(lime). Clicking a tab activates it. The strip scrolls horizontally on overflow.

## Data flow

```
Home "New workspace"  ┐
tabstrip "+"          ┘─▶ createWorkspace(dir,name) → activate → openModal → spawn crew INTO activeWs
topbar "New agent"    ┐
in-grid spawn tile    ┘─▶ openModal (prefill activeWs.dir) → spawn INTO activeWs
tab click             ──▶ activateWorkspace(id)
tab ×                 ──▶ confirm if panes>0 → kill ws panes → removeWorkspace → activate next / Home
window X              ──▶ onCloseRequested → total>0 ? confirm → killAll → close : close
```

The spawn modal always targets `activeWs`. `createWorkspace` is called first for
the "new tab" entry points so `activeWs` already points at the new (empty) tab
when the modal spawns.

## Close-on-quit behavior

Register `getCurrentWindow().onCloseRequested(handler)` once at startup:

```
handler(event):
  total = sum of pane counts across workspaces
  if total === 0: return            // let the window close
  event.preventDefault()
  ok = await confirm("Tất cả {total} terminal đang chạy sẽ bị tắt. Đóng Maestro?",
                     { title: "Đóng Maestro", kind: "warning" })
  if ok: await killAll(); await getCurrentWindow().destroy()
```

`confirm` is the native Tauri dialog (`@tauri-apps/plugin-dialog`, already a
dependency — not a webview-blocking JS `confirm`). `destroy()` closes without re-
firing `onCloseRequested`.

Capabilities: add `core:window:allow-close` and `core:window:allow-destroy` to
`src-tauri/capabilities/default.json` (`dialog:default` already grants confirm).

## Error handling

- Closing a tab with no agents skips the confirm.
- `killAll()` failure on quit is swallowed; the window still closes.
- Spawning when there is no active workspace (shouldn't happen — entry points
  guarantee one) defensively creates one first.

## Testing (vitest)

`src/workspaces.test.ts` covers the pure helpers:
- `nextWorkspaceName` returns dir basename; falls back to `Workspace 1/2/…`
  skipping taken names.
- `pickNextActive` returns a neighbour, `null` when it was the only one.
- `needsCloseConfirm` true iff total > 0.

DOM/tab wiring and the close handler are verified manually in the built app
(spawn agents across two tabs, switch, close a tab, close the window).

## Files touched

- Create `src/workspaces.ts` + `src/workspaces.test.ts` — pure helpers.
- `index.html` — tabstrip row + styles; the static `#grid` becomes a per-
  workspace grid created in JS (a `#workspaces` host replaces the single grid).
- `src/main.ts` — Workspace model, tab strip rendering, per-workspace refactor of
  the pane functions, the modal-targets-activeWs flow, and the close handler.
- `src/ipc.ts` — `onCloseRequested` + `confirmDialog` wrappers.
- `src-tauri/capabilities/default.json` — window close/destroy permissions.
