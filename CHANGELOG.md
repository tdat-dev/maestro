# Changelog

All notable changes to Maestro are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Full web terminal in the remote dashboard** — tapping an agent now offers
  *Open full terminal*: a real xterm.js terminal streamed from the app over
  Server-Sent Events, with keystrokes (including arrows, Enter, Ctrl+C, and
  editing) sent straight to the agent's PTY. Type directly and interactively
  from your phone — no key buttons needed — the same as sitting at the machine.
  xterm.js is bundled and served same-origin so it works offline/LAN. Output is
  streamed over a **WebSocket** (on the dashboard port + 1) with TCP_NODELAY, so
  typing and deleting feel near-direct — bidirectional, ordered by nature, no
  per-keystroke HTTP round-trip. (An earlier SSE + POST transport was too laggy:
  tiny_http buffers streaming responses and can't set TCP_NODELAY.)

### Changed

- **Maestro enforces its board protocol on Claude agents** — every Claude Code
  agent Maestro spawns is launched with `--append-system-prompt` carrying the
  plan-first rules, so it *must* plan on the board (call `board_get`, add cards,
  report via `card_move`/`card_done`) rather than treating the MCP hint as
  optional. No button, no terminal noise; other CLIs still get the MCP tools
  and server instructions.
- **Board toolbar simplified** — the maestro-mcp server now ships the plan-first
  convention (few big cards, small steps as each card's checklist, report via
  `card_move`/`card_done`) as its MCP instructions, so an agent with the board
  tools plans and adds cards directly. The **Plan with AI** button (which used
  to drop a rules file and prime the agent) is therefore gone, alongside the
  earlier **Import** and **Send approved** removals — the board toolbar is now
  just the Conductor and a compact Capture-web icon.

### Added

- **Board ⇄ Agent loop** — kanban cards can be dispatched to a specific
  running agent ("Send to agent…" in the card detail, or drag the card onto a
  pane): the agent receives a structured prompt, the card records its
  `assignee` and jumps to Doing, and the card shows a clickable agent chip
  that focuses the pane. Maestro sets `MAESTRO_AGENT` on every spawn so
  maestro-mcp records who moved/finished each card, and the app toasts (+ OS
  notification when unfocused) when an agent lands a card in Done.
- **Right-click copies the terminal selection** — copy-on-select can lose the
  clipboard write when another Windows process holds the clipboard lock;
  right-clicking a selection retries the copy.
- **Fleet monitor** (`Ctrl+Shift+L`) — a dock panel listing every agent across
  all workspaces with live status (needs-you / working / idle / stopped),
  uptime, and owning workspace; click to jump to any agent, and a rail badge
  counts how many are waiting on you.
- **Fleet coordination for agents** — maestro-mcp gains `fleet_status` (see the
  other agents and their status) and `fleet_send` (message another agent, or
  broadcast), delivered through a `.maestro/fleet.json` + `outbox.jsonl` file
  bridge so agents can hand off work to each other.
- **Remote fleet dashboard** — Settings → *Remote fleet dashboard*: Maestro
  serves a small web page (default localhost, LAN opt-in) showing every agent
  and its status. Tap an agent to see a live tail of its terminal output (read
  straight from the rendered screen, so a TUI's spinners don't spam) *and* drive
  it: a row of key buttons (up/down/Enter/Esc/Tab/^C) sends raw keys so you can
  navigate an interactive menu like `/resume` from your phone, plus a message
  box for text. The LAN toggle is off by default since the page can drive an
  agent.
- **Scheduled agents** — Settings → *Manage schedules*: launch a saved crew
  preset automatically at a set time, once or daily. Each schedule shows its
  next run and can be paused or deleted.
- **Conductor** — an in-app auto-dispatch scheduler on the board toolbar,
  cycling Off → Semi → Auto → Pipeline. *Semi* hands each free agent the next
  approved ("To do") card automatically; *Auto* also promotes cards from
  Proposed to keep agents fed; *Pipeline* flows each card through Build → Test
  → Review → Done, handing every stage to a free agent with a stage-specific
  prompt and detecting each hand-off. Deterministic (no extra LLM cost — the
  agents do the work), scoped per workspace, click through to Off to stop.

### Fixed

- **MCP wrote to the wrong project's board** — maestro-mcp resolved the board
  from the agent's current directory, so an agent whose cwd drifted (a `cd`, a
  subdir, a git worktree) could write cards into a different project's board.
  It now prefers the `MAESTRO_WORKSPACE` env Maestro sets on every spawn.

## [0.3.9] - 2026-07-09

### Removed

- **Merge button** on the topbar in detached windows (workspace fold-back still
  works via drag-and-drop between windows).
- **Isolate each agent in its own git worktree** toggle from the spawn modal
  and workspace wizard — new agents always run in the project folder.

## [0.3.8] - 2026-07-05

### Added

- **Resume all** — reopening a project parks every agent as *stopped*, and you
  used to have to click ⟳ on each pane to bring the fleet back. A new **Resume
  all** button now appears in the topbar whenever the current project has any
  stopped or exited agents (with a live count) — one click boots them all. They
  start one at a time on purpose, so a large crew doesn't hammer the disk and
  freeze the window the way a parallel spawn would.

## [0.3.4] - 2026-07-02

### Fixed

- **App froze while spawning a crew** — booting several isolated agents at once
  locked up the whole window (and dragged the machine down) until every agent
  had started. All Tauri commands ran synchronously on the main/UI thread, so
  each agent's `git worktree add` (a full repo checkout) and ConPTY creation
  blocked rendering and input. Heavy commands (PTY, worktree, git review, PATH
  probing) now run on a background thread pool, and worktree checkouts queue
  one-at-a-time instead of thrashing the disk in parallel. The UI stays
  responsive for the whole boot.

## [0.3.1] - 2026-06-29

### Fixed

- **Worktree disk bloat** — every git worktree that ran `cargo build` created its
  own `src-tauri/target` (~10 GB for a Tauri build), silently filling the disk.
  New worktrees now get a `.cargo/config.toml` pointing `target-dir` at the main
  repo's target, so all worktrees of a repo share one build cache instead of
  duplicating it.

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
