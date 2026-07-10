# Board ⇄ Agent loop — Phase 1 design

Date: 2026-07-10 · Status: approved · Branch: `feat/maestro-mcp`

## Goal

Close the loop between the kanban board and the agent fleet: a card can be
**dispatched** to a specific running agent with one action, the board **shows
who is working on what**, and Maestro **notifies** when an agent finishes a
card. This is the foundation the later Conductor (auto-pilot) and Pipelines
phases build on.

## What already exists (reused, not rebuilt)

- `pollBoardJson()` in `src/kanban.ts` reloads the board when maestro-mcp
  rewrites `.maestro/board.json` (interval poll, skipped mid-drag/mid-edit).
- Dragging a card onto a pane types `cardToAgentText(card)` into that pane's
  PTY (`agentbridge.dropTextIntoPaneAt`).
- maestro-mcp tools: `board_get`, `card_add/update/move/delete`, `card_done`
  (moves to Done + git evidence), list ops.
- OS notification helper (`notify`, used by "needs you" alerts).
- Rust `CommandSpec` already carries `env: Vec<(String, String)>` down to
  `CommandBuilder::env` — only the `pty_spawn` Tauri command and `ipc.spawnPty`
  don't expose it yet.

## 1. Data model: `card.assignee`

- `Card` gains `assignee?: string` — the pane's display name (e.g.
  `Claude Code #1`) — in **both** `src/board.ts` and `mcp/src/board.ts`.
- `normalizeCard` in both packages accepts a string and drops anything else.
  Additive and optional: old boards load unchanged, old app versions ignore
  the field (normalize strips it on next write — acceptable for a v0.x file
  shared by one machine).
- `DoneInfo` gains `by?: string` — who finished the card (from
  `MAESTRO_AGENT`, see §4).

## 2. Structured dispatch

New module `src/dispatch.ts` (pure, unit-testable) + wiring in kanban/main:

- `dispatchPrompt(card: Card): string` — the prompt typed into the agent:
  - `cardToAgentText(card)` (title, desc, open checklist items), then
  - instructions: *use the maestro MCP `card_move` tool to move this card to
    "Doing" when you start, and `card_done "<title>"` with a summary when
    finished; if you don't have maestro tools, just do the task.*
- **"Send to agent" on a card** (card context/detail action): opens a picker
  listing the current workspace's **running** panes (badge colour + name).
  Picking one:
  1. types `dispatchPrompt(card)` into that pane's PTY and submits (Enter),
  2. sets `card.assignee = pane name`, moves the card to the "Doing" list
     (created if missing), saves the board,
  3. toasts `→ sent to <name>`.
- **Drag-card-onto-pane** upgrades to the same path: same prompt (still no
  Enter, matching today's behaviour), and now also sets `assignee` + moves
  the card to Doing.
- agentbridge grows the hooks the board needs: `listAgents(): {id, name,
  running}[]`, `sendToAgentById(id, text, submit)`, `focusPane(id)` —
  registered by main.ts like the existing sender/targeting hooks.

## 3. Board UI: who is doing what

- Card front + detail view render an **assignee chip** (`⚡ <name>`); clicking
  it focuses that pane (via `focusPane`, matched by name → pane). A "×" in the
  detail view clears the assignee.
- `pollBoardJson` diffs Done membership before/after an external reload: any
  card that *newly arrived* in Done (and wasn't moved by the UI itself) fires
  - an in-app toast `✅ <assignee ?? "agent"> finished: <title>`, and
  - an OS `notify()` when the window is unfocused (same pattern as
    "needs you").

## 4. Agent identity: `MAESTRO_AGENT`

- `pty_spawn` (Rust) accepts optional `env: Vec<(String, String)>`, applied to
  `CommandSpec.env`. `ipc.spawnPty` passes it; main.ts sends
  `MAESTRO_AGENT=<pane name>` (and `MAESTRO_WORKSPACE=<dir>`) on every spawn.
- maestro-mcp reads `process.env.MAESTRO_AGENT`; when present:
  - `card_done` stamps `done.by = MAESTRO_AGENT`,
  - `card_move` to Doing sets `assignee = MAESTRO_AGENT` if the card has none
    (an agent claiming unassigned work records itself).

## Error handling

- Dispatch to a pane that died between render and click → picker filters
  non-running panes; `sendToAgentById` returns false → toast "agent not
  running", card untouched.
- Board write conflicts: existing atomic-write + torn-read retry paths are
  unchanged; assignee rides inside the normal card payload.
- Missing "Doing" list → created on demand (same as mcp `card_done` does for
  Done).

## Testing

- Unit: assignee/`done.by` normalize round-trip + legacy board compat (both
  packages); `dispatchPrompt` content; Done-arrival diff helper.
- Manual: dispatch → agent runs → `card_done` → chip, toast, OS notification;
  drag-to-pane path; agent without maestro-mcp still receives the task text.

## Out of scope (later phases)

Fleet status dashboard, conductor auto-assignment, pipelines, WebSocket push
(poll stays), multi-workspace boards.
