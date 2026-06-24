# Changelog

All notable changes to Maestro are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-06-24

### Fixed

- **opencode panes no longer render blank** — opencode's OpenTUI front-end only
  performs its first paint after receiving a terminal resize event, so a freshly
  spawned pane whose size never changed stayed black. Maestro now fires a one-off
  resize "jiggle" on the pane's first byte of output (when the process is up and
  listening), forcing the initial render. Scoped to OpenTUI-style CLIs.

## [0.2.0] - 2026-06-19

### Added

- **Tool dock** — a permanent icon rail on the right edge of the workspace that
  toggles slide-in panels, so the side tools are always one click (or one
  shortcut) away instead of buried in the top bar. Press `Esc` to close.
- **Kanban board** (`Ctrl+Shift+K`) — a Trello-style board scoped to each
  workspace folder: add/rename/delete/reorder lists, drag cards within and
  across lists, and a card detail view with description, colour labels, due
  date, and a checklist. Drag uses Pointer Events (HTML5 drag-and-drop is
  swallowed by the WebView2 OS drag-drop handler). Boards persist per folder.
- **Pomodoro timer** (`Ctrl+Shift+J`) — a per-folder focus/break timer with a
  progress ring, configurable focus/break lengths, session tracking, and an OS
  notification when a phase ends. A live `mm:ss` badge shows on the rail while
  running, and timers keep ticking across tab switches.

### Changed

- **Git diff review moved into the dock** (`Ctrl+Shift+D`) — the old top-bar
  "AI Code" overlay was redesigned as a dock panel with a cleaner diff view,
  repo selector, branch/worktree badge, and commit / discard / merge actions.
  The top-bar "AI Code" button was removed.

## [0.1.10] - 2026-06-15

### Fixed

- **Killing a maximized pane no longer blanks the whole workspace** — the ⤢
  maximize state (`.has-max` on the grid) was left behind when its pane was
  closed/killed, so `.grid.has-max .pane{display:none}` hid every remaining
  pane with nothing maximized to show. `layoutGrid` now drops `has-max`
  whenever no `.maxed` pane remains.

## [0.1.9] - 2026-06-15

### Fixed

- **Browser zoom no longer breaks the terminal panes** — WebView2's built-in
  zoom (Ctrl+scroll / Ctrl +/-/0) is now blocked. Zooming scaled the whole page
  and corrupted xterm's DOM-renderer glyph metrics, so clicking WebView2's
  "Reset" toast left every pane blank/off-screen. Use Settings → terminal font
  size to resize terminal text instead.

## [0.1.8] - 2026-06-11

### Added

- **AI Code Slice 2** — commit an agent's worktree changes, merge its branch
  into the main repo (`--no-ff`, conflicts abort and report the files), discard
  uncommitted work, and clean up the worktree + branch after a merge.
- **"Needs you" attention alerts** — a running agent whose output goes silent
  flags amber on its pane pill and workspace tab, with an OS notification when
  the window is unfocused.
- **Keyboard shortcuts** — Alt+1–9 focus pane, Ctrl(+Shift)+Tab cycle
  workspaces, Ctrl+Shift+T new workspace, Ctrl+Shift+F find in pane,
  Ctrl+Shift+B broadcast.
- Ctrl+Click on a terminal link opens it in the default browser.
- CLIs not found on PATH are grayed out in the spawn wizard and modal.
- Terminal font size setting (Settings → applies live to every pane).
- README and MIT LICENSE; repository metadata and project logo.
- CI (typecheck, tests, cargo) and tag-triggered signed release workflows.

## [0.1.7]

### Added

- Workspace setup wizard for spinning up fleets of agents.
- Multi-select model picker and reusable presets.
- Floating pane pills for quick navigation between agents.
- Frameless grid layout.

### Changed

- Merge a detached agent window back into the main grid.

### Fixed

- Dev server port mismatch.

## [0.1.6]

### Fixed

- Restore Ctrl+V paste — xterm was swallowing the keydown so the native paste never fired.

## [0.1.5]

### Added

- Tab reorder and rename.
- Detached agent windows.
- Home screen mascot.

### Fixed

- Paste no longer duplicates input; copy-on-select.

## [0.1.4]

### Fixed

- Spawn git with `CREATE_NO_WINDOW` — no more flashing console windows on Windows.

## [0.1.3]

### Added

- Drop a file onto a pane to type its path into that agent's terminal.
- Pretty in-app update toast with download progress.

### Changed

- Performance: dropped redundant repaint-on-modal-open that caused a reflow hitch.

## [0.1.2]

### Added

- "Check for updates" button in Settings.

### Changed

- Stream PTY terminal output as raw bytes instead of a JSON `number[]`.

### Fixed

- Disable xterm WebGL renderer — fixes WebView2 GPU stall.
- Clear WebView2 compositor lag while a modal is open.

## [0.1.1]

### Added

- AI Code review (work in progress): read-only multi-repo unified-diff view wired to an AI Code toggle.
- Mascot, terminal clipboard support, and idle black-screen fix.
- Per-agent worktree isolation on spawn.

## [0.1.0]

- Initial release: spawn and orchestrate fleets of AI agent CLIs with real terminals and real tree-kill.
