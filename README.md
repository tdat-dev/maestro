<div align="center">

<img src="design/logo.svg" width="110" alt="Maestro logo">

# Maestro

**Spawn & orchestrate fleets of AI agent CLIs — real terminals, real tree-kill.**

[![Latest release](https://img.shields.io/github/v/release/tdat-dev/maestro?label=release&color=c6f135)](https://github.com/tdat-dev/maestro/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078d6)](https://github.com/tdat-dev/maestro/releases/latest)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db)](https://tauri.app)

A native Windows desktop app for running many AI coding agents side by side —
Claude Code, Codex, Gemini, Aider, Cursor Agent, Copilot, and more — each in a
real ConPTY terminal, tiled into workspaces you can rearrange, detach, and
merge like a window manager built for agent swarms.

[Download the latest installer »](https://github.com/tdat-dev/maestro/releases/latest)

</div>

---

## Why

Running one AI CLI is easy. Running **eight of them across three repos** —
spawning, watching, killing, reviewing what each one changed — is a tab-juggling
nightmare. Maestro turns that into a single orchestrated surface: one window,
tiled live terminals, one broadcast bar, one diff review.

## Features

- **Workspace wizard** — pick a folder, tap a tile for how many terminals
  (1–12, with live grid preview), multi-select which models fill them, hit
  spawn. Recent folders and one-click **presets** (folder + models + count
  baked in) make respawning a whole crew a single tap.
- **Real terminals** — every agent runs in a genuine Windows ConPTY via a Rust
  backend (xterm.js front), with tree-kill on close so no orphaned `node.exe`
  swarms survive.
- **11 CLIs built in, plus custom** — Claude Code, Codex, Gemini, Aider,
  Cursor Agent, opencode, Qwen Code, GitHub Copilot, Goose, PowerShell, CMD,
  or any command you type. Optional skip-permissions flag per spawn.
- **Frameless tiling** — terminals run edge-to-edge with a floating control
  pill per pane (search, maximize, restart, kill). Drag pills to reorder
  panes; drag tabs to reorder workspaces.
- **Detach & merge windows** — drag a workspace tab out to give it its own
  window; drag it back (or hit *Merge*) to fold it into the main window.
  Agents keep running through both moves.
- **Broadcast** — type once, send to every running agent (or a selected
  subset).
- **Git worktree isolation** — optionally give each agent its own worktree +
  branch off HEAD, so parallel agents never trample each other and every
  agent's changes are reviewable in isolation.
- **AI Code review** — built-in diff viewer to walk through what each agent
  changed.
- **Quality of life** — Ctrl+Click links in terminal output, find-in-output,
  copy-on-select, drag-and-drop a file onto a pane to paste its path, session
  restore, system tray, signed auto-updates… and a mascot who lives on the
  home screen.

## Install

Grab `maestro_<version>_x64-setup.exe` from the
[latest release](https://github.com/tdat-dev/maestro/releases/latest) and run
it. Maestro auto-updates from then on (signed releases via the Tauri updater).

> **Requirements:** Windows 10/11 x64. The AI CLIs themselves (e.g. `claude`,
> `codex`, `gemini`) must be on your `PATH` — Maestro launches them, it doesn't
> install them.

## Development

```powershell
git clone https://github.com/tdat-dev/maestro.git
cd maestro
npm install
npm run tauri dev     # full app (Vite + Rust backend)
npm test              # vitest unit tests
npx tsc --noEmit      # typecheck
```

Prerequisites: Node 20+, Rust (stable, MSVC toolchain), and the
[Tauri 2 Windows prerequisites](https://tauri.app/start/prerequisites/).

### Project layout

```
src/            TypeScript frontend (vanilla, no framework)
  main.ts       app orchestration: workspaces, panes, wizard, broadcast
  terminal.ts   xterm.js mounting (links, search, clipboard)
  crew.ts       CLI presets + crew expansion logic
  wizard.ts     pure helpers for the setup wizard (tiles, model split)
  ipc.ts        thin typed wrappers over the Tauri commands/plugins
  styles/       one CSS file per feature
src-tauri/      Rust backend: ConPTY spawn/attach, tree-kill, tray, updater
docs/           releasing guide & design notes
```

### Releasing

See [docs/RELEASING.md](docs/RELEASING.md) — bump three versions, build
signed, publish a GitHub release with the installer + `latest.json`.

## License

[MIT](LICENSE) © 2026 [tdat-dev](https://github.com/tdat-dev)

Built with [Tauri](https://tauri.app), [xterm.js](https://xtermjs.org), and
[portable-pty](https://crates.io/crates/portable-pty).
