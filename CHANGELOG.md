# Changelog

All notable changes to Maestro are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Ctrl+Click on a terminal link opens it in the default browser.
- README and MIT LICENSE; repository metadata and project logo.

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
