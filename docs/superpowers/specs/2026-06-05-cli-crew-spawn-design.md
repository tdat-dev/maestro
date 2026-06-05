# CLI Crew Spawn — Design

**Date:** 2026-06-05
**Status:** Approved (design) — pending implementation plan

## Problem

When spawning multiple agents, the user must type a shell command into a
free-text field (`powershell.exe -NoLogo`). They want to instead **pick which
CLI each agent runs** from a list of well-known AI agent CLIs (Claude Code,
Codex, Gemini, …) so a pane just opens with that CLI already running — no typing
a command. Spawning a fleet of heavy CLIs at once must **not lag the machine**.

## Goals

- Replace the free-text command field with a **crew builder**: pick a per-CLI
  count and spawn a mixed crew (e.g. 2 Claude + 1 Codex + 1 shell) in one action.
- Each pane launches its chosen CLI directly (already the case — backend spawns
  `program + args`); the change is the picker, not the spawn mechanism.
- Per-pane badge reflects the actual CLI instead of the hardcoded `shell`.
- Spawning N heavy CLIs stays responsive (no CPU/GPU stall).

## Non-Goals

- No backend (Rust) change to the spawn API. `pty_spawn(program, args, cwd, …)`
  is already generic; the CLI choice is purely a frontend mapping to
  `program`/`args`.
- No per-CLI feature integration (no auto-prompts, no MCP wiring) — just launch.
- No detection of which CLIs are installed. A missing CLI fails the spawn and
  shows the existing red "spawn failed" state.

## Approach

Frontend-only. Three pieces: a CLI registry, a crew-builder modal, and a
lag-aware spawn queue. (Chosen over "just stagger" / "just WebGL budget" because
the lag has two independent sources — process boot CPU spike and per-pane WebGL
context thrash — and both need addressing.)

### 1. CLI registry

A constant list in `src/main.ts`. Each entry maps a friendly CLI to a concrete
program + args + badge:

```ts
interface CliPreset {
  id: string;       // "claude"
  label: string;    // "Claude Code"
  program: string;  // "claude"
  args: string[];   // []
  badge: string;    // "claude"  — shown in the pane header
  shell?: boolean;  // true for plain shells (styling/grouping only)
}
```

Default list (binary names editable later if a user's PATH differs):

| label          | program          | args        | badge   |
|----------------|------------------|-------------|---------|
| Claude Code    | `claude`         | —           | claude  |
| Codex          | `codex`          | —           | codex   |
| Gemini         | `gemini`         | —           | gemini  |
| Aider          | `aider`          | —           | aider   |
| Cursor Agent   | `cursor-agent`   | —           | cursor  |
| opencode       | `opencode`       | —           | opencode|
| Qwen Code      | `qwen`           | —           | qwen    |
| GitHub Copilot | `copilot`        | —           | copilot |
| Goose          | `goose`          | —           | goose   |
| PowerShell     | `powershell.exe` | `-NoLogo`   | shell   |
| CMD            | `cmd.exe`        | —           | cmd     |

Plus a **Custom** entry: a free-text command (parsed `program + args`, same as
today's field) with its own count — covers any other CLI the user wants.

### 2. Crew-builder modal

Replaces the single "Shell / command" field. Layout:

- **Working directory** — unchanged (input + Browse + recents wiring stays).
- **Crew** — a grid of CLI cards. Each card shows the label, badge, and a
  stepper `− N +` (default 0). A running **total** is shown.
- **Custom command** — one row: free-text input + its own stepper.
- **Spawn** button label reflects the total, e.g. "Spawn 4 agents"; disabled
  when total is 0.

Persistence: the crew (counts per CLI + custom command) and directory are saved
to `localStorage` and restored on open, replacing the current `maestro.spawn`
shape. Recent folders behavior is unchanged.

### 3. Lag-aware spawn

`spawnFromModal` expands the crew into a flat ordered list of presets (each
repeated by its count). Then:

- **Render all panes immediately** with the correct badge and a `queued…`
  status, so the user sees the full fleet appear at once.
- **Boot processes through a concurrency-limited queue** — at most
  `MAX_CONCURRENT_BOOT` (≈ 2–3) `pty_spawn` calls in flight; the next starts when
  a prior resolves. This spreads the CPU spike of many heavy CLI startups instead
  of firing all at once.

### 4. WebGL budget (renderer)

`mountTerminal` gains an option controlling whether to attach the WebGL addon.
A module-level counter tracks live WebGL contexts; `mountTerminal` attaches WebGL
only while under a budget (≈ 8) and otherwise stays on the default DOM renderer.
The counter decrements on `dispose`. This prevents context thrash when many panes
are open while keeping GPU acceleration for a reasonable working set.

### 5. Badge wiring

`createAgent` takes the preset's `badge` and renders it in `.badge` instead of
the hardcoded `"shell"`. Restart re-uses the same preset/badge.

## Data flow

```
modal crew state ──expand──▶ [preset, preset, …]
        │                          │
   localStorage              for each: createAgent(program,args,cwd,name,badge)
                                   │            └─ mount pane + xterm (WebGL if budget)
                                   ▼
                          boot queue (≤ MAX_CONCURRENT_BOOT)
                                   │
                                   ▼  pty_spawn (Rust, unchanged)
                          running │ exited │ spawn failed
```

## Error handling

- Total = 0 → Spawn disabled (no-op).
- Missing CLI / bad program → `pty_spawn` rejects → existing red "spawn failed"
  state in the pane (unchanged).
- Custom command empty but count > 0 → treat as 0 (skip), or block spawn; pick
  one: **skip empty custom rows**.

## Testing (vitest, existing harness)

Extract pure functions so logic is unit-testable without the DOM:

- `expandCrew(crew): Preset[]` — counts → flat ordered list (incl. custom).
- Boot queue concurrency — a `runLimited(tasks, limit)` helper never exceeds
  `limit` in flight and runs every task.
- Registry mapping — preset → `{program, args, badge}` is correct, custom command
  parses `program + args`.

DOM/modal wiring is covered manually (run the app, spawn a mixed crew).

## Files touched

- `index.html` — modal markup: crew grid + custom row + dynamic Spawn label.
- `src/main.ts` — CLI registry, crew state + persistence, `expandCrew`,
  concurrency-limited boot queue, badge param threaded through `createAgent`.
- `src/terminal.ts` — WebGL budget option + live-context counter.
- `src/*.test.ts` — tests for `expandCrew`, `runLimited`, registry mapping.

## Open questions

- Exact default binary names per CLI (PATH may differ per machine) — editable in
  the registry; Custom row covers gaps.
- `MAX_CONCURRENT_BOOT` and WebGL budget values — start at 2–3 and 8; tune by
  feel.
