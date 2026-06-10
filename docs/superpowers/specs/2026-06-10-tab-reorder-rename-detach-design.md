# Tab reorder, rename, and detach-to-window — design

Date: 2026-06-10
Status: approved (user picked "agents keep running" for detach)

## Goal

Three tabstrip features:

1. **Drag-reorder tabs** — drag a tab left/right within the tabstrip; order persists.
2. **Rename tabs** — double-click a tab to edit its name inline.
3. **Detach tab to a new window** — drop a tab outside the window and it moves
   into a brand-new Maestro window. Running agents are NOT killed: the new
   window re-attaches to the same backend PTYs and replays recent scrollback.

## Architecture

### Backend (Rust)

PTYs already live in app-global `AppState.registry`, not per-window — only the
output `Channel` is bound to the spawning webview. Changes:

- `core/agent.rs`: the reader thread writes each chunk into a shared
  `Arc<Mutex<Output>>` holding a ~512 KB ring buffer (`VecDeque<u8>`) plus the
  current sink (`Box<dyn FnMut(&[u8]) + Send>`), then forwards to the sink.
  New `Agent::attach(sink)`: under the same lock, replay the buffered bytes
  through the new sink, then swap it in — no gap, no duplication.
- `core/registry.rs`: `attach(id, sink)` passthrough.
- `commands.rs` + `lib.rs`: new `pty_attach(agent_id, on_bytes: Channel)`
  command mirroring `pty_spawn`'s raw-bytes channel.
- `capabilities/default.json`: window list gains `detach-*`; add
  `core:webview:allow-create-webview-window`.

### Frontend

- **Reorder**: tabs become `draggable`; `dragover` on a sibling live-inserts
  before/after by X midpoint (same pattern as pane drag); `dragend` inside the
  viewport commits the `workspaces` Map to DOM order + `saveSession()`.
- **Rename**: dblclick (not on ✕) swaps `.tname` to an inline input.
  Enter/blur commits (`ws.name`, `saveSession`), Escape cancels. Tab dragging
  is disabled while editing.
- **Detach**: `dragend` with the pointer outside the viewport →
  `detachWorkspace(ws)`:
  1. Write a handoff payload (`maestro.detach.<key>`: name/dir/repoRoot/
     isolated + per-agent `{spec, id, running, spawnedAt}`) to localStorage
     (shared across windows, same origin).
  2. Open `WebviewWindow("detach-<key>", { url: "/?detach=<key>",
     decorations: false, ... })`.
  3. On success, drop the tab locally WITHOUT killing PTYs (dispose xterms,
     remove DOM, delete from map, saveSession).
- **Detach boot path** (`?detach=<key>` in the URL): skip `killAll()`/
  `restoreSession()`/splash/update-check/tray wiring; read + delete the
  payload; rebuild the workspace; running agents mount and call `pty_attach`
  (keeping their original agent ids and `spawnedAt`), stopped agents mount as
  parked panes (existing restore mechanism). `pty_attach` failure (agent died
  mid-handoff) shows `exited`.

### Multi-window lifecycle

- `pty-exit` is already app-wide; each window resolves only its own pane ids.
- Detached windows persist their session under
  `maestro.session.detach.<key>`; the main window's `restoreSession()` also
  sweeps any leftover detach keys (app quit/crash while detached) into
  restored-stopped tabs, then deletes them.
- Closing a **detached** window: confirm if it has panes, kill only ITS pane
  PTYs, delete its session key, destroy.
- Closing the **main** window quits the app: confirm counts own panes + the
  detach session keys, `pty_kill_all`, then broadcast a `maestro-quit` event
  so detached windows destroy themselves. Tray-quit is main-window-only.
- The spawn callback in `createAgent` now guards `ws.panes.has(id)` so output
  arriving after a detach handoff can't write to a disposed xterm.
- Detached windows never "hide to tray" on minimize (the tray can only re-show
  the MAIN window — hiding a detached one would lose it); they minimize
  normally regardless of the setting.

## Known limits (accepted)

- Re-attached scrollback is capped at the 512 KB ring buffer (a few thousand
  lines), not unlimited history.
- Dev-mode HMR reload of the main window still runs `killAll()` and would kill
  detached windows' agents (dev-only; prod main never reloads).
- Dragging a tab INTO another window's tabstrip (merge) is out of scope.
