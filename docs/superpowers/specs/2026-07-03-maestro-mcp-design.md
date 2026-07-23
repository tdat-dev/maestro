# Maestro MCP server — kanban bridge (design)

Date: 2026-07-03
Status: draft, awaiting user review

## Goal

Agents running inside Maestro panes connect to an MCP server named `maestro` and
operate the workspace kanban board directly: read the board, add/update/delete
cards, add/rename/delete lists, and move cards between lists. This replaces the
indirect plan.json/done.json handshake as the primary agent⇄board channel (the
file handshake stays for backward compatibility).

Decisions made with the user:

- **Clients**: only agents spawned inside Maestro panes (no external sessions in v1) —
  though the npx package works anywhere, external use just isn't documented/supported.
- **Source of truth**: `.maestro/board.json` in the workspace folder.
- **Delivery**: Node/TS package published to GitHub (+ npm), installed like any
  standard MCP server: `claude mcp add maestro -- npx -y maestro-mcp`.
  (User rejected the Rust sidecar option — they want the familiar install-command flow.)

## Architecture

```
Agent (claude in a pane) ──stdio MCP──> npx maestro-mcp <──read/write──> .maestro/board.json
                                                                              ▲
Maestro UI (kanban.ts) ── mtime poll (3.5s watch loop) + IPC fs read/write ───┘
```

### board.json — source of truth

- Path: `<workspace>\.maestro\board.json`.
- Schema: the existing `Board` type, wrapped with a version field:

```json
{
  "version": 2,
  "lists": [
    {
      "id": "l…",
      "title": "To do",
      "cards": [
        {
          "id": "c…",
          "title": "…",
          "desc": "",
          "labels": ["blue"],
          "due": null,
          "checklist": [{ "id": "i…", "text": "…", "done": false }],
          "done": { "repoRoot": "…", "files": ["…"], "summary": "…", "at": 0 }
        }
      ]
    }
  ]
}
```

- `done` on a card is optional (present once the task has completion evidence),
  matching `normalizeCard` in `src/kanban.ts`.
- Both writers (UI and MCP server) use atomic writes: write to a temp file in the
  same directory, then rename over board.json.
- Both writers follow read-latest → mutate → write for every mutation, so neither
  side clobbers changes it hasn't seen. The UI keeps rendering from its last-read
  copy; the 3.5s watch loop reloads and re-renders when mtime changes.

### maestro-mcp — Node/TS package

- Lives in `mcp/` inside the maestro repo (own `package.json`, name `maestro-mcp`,
  `bin` entry pointing at the built server). Published to npm; installable via
  `npx -y maestro-mcp` or straight from GitHub (`npx -y github:tdat-dev/maestro#path:mcp`
  until the npm publish lands).
- Built with the official `@modelcontextprotocol/sdk` (`McpServer` +
  `StdioServerTransport`), schemas via `zod`. TypeScript, bundled to a single
  `dist/index.js` with a `#!/usr/bin/env node` shebang.
- Workspace resolution: optional CLI arg `maestro-mcp <dir>`; when omitted,
  defaults to `process.cwd()`. Claude Code spawns stdio servers with cwd = the
  project root, so a single user-scoped install
  (`claude mcp add --scope user maestro -- npx -y maestro-mcp`) covers every
  workspace with no per-project config.
- If board.json is missing, the first read materialises the default board
  (To do / Doing / Done) in memory; the first mutation creates the file
  (and `.maestro/` if needed).
- If board.json exists but is invalid JSON, tools return a clear MCP error and
  never overwrite the corrupt file (the user may have hand-edited it).

### Tools

| Tool | Params | Behaviour |
|------|--------|-----------|
| `board_get` | — | Full board as JSON text. |
| `card_add` | `list`, `title`, `desc?`, `labels?`, `due?`, `checklist?` (string[]) | Append card to the list. `list` accepts a list id or title (case-insensitive). Creates the list if the title doesn't exist. |
| `card_update` | `card`, `title?`, `desc?`, `labels?`, `due?`, `checklist?` | Patch fields that are present. `card` accepts card id or exact title. |
| `card_move` | `card`, `to_list`, `position?` (0-based) | Move card; omitted position = append at end. |
| `card_delete` | `card` | Remove the card. |
| `card_done` | `card`, `summary?` | Move to the "Done" list (created if missing) and attach evidence: `repoRoot` = workspace dir, `files` = output of `git diff --name-only HEAD` + untracked from `git status --porcelain` (empty list when git is absent/not a repo), `at` = now. |
| `list_add` | `title` | Append a new empty list. |
| `list_rename` | `list`, `title` | Rename. |
| `list_delete` | `list` | Delete list and its cards. |

Resolution rules:

- id match wins over title match.
- Title matches are case-insensitive, trimmed.
- A title matching multiple cards/lists returns an error telling the agent to use
  the id (ids are visible in `board_get`).
- Labels are validated against the existing palette keys
  (green|yellow|orange|red|purple|blue); unknown labels are rejected.
- `due` must be `yyyy-mm-dd` or null.
- New ids use the same shape as the TS `uid()` (prefix + base36 time + counter);
  exact format is not load-bearing, only uniqueness.

### UI changes (`src/kanban.ts`)

- Persistence moves from localStorage to board.json **when the workspace has a
  dir**. Dir-less quick terminals keep the current localStorage behaviour.
- One-time migration: on first load, if board.json is missing and
  `maestro.kanban.v2.<key>` exists in localStorage, write it to board.json
  (localStorage copy left in place as a backup, no longer read once the file
  exists).
- Every UI mutation (add/rename/delete list, add/patch/move/delete card,
  drag-commit) re-reads board.json, applies the change to the fresh copy, writes
  atomically, then renders.
- The existing 3.5s watch loop gains a board.json mtime check: on external
  change, reload and re-render (skipping reload while a drag is in progress or a
  card detail textarea is focused, to avoid yanking state out from under the
  user; the reload happens on the next tick after the interaction ends).
- The `.maestro/board.md` mirror keeps being regenerated on every change (agents
  without MCP still read it).
- plan.json / done.json import flows are unchanged (their mutations now persist
  through the same file-write path).
- Done-evidence capture on UI drags to Done is unchanged.

### Install / agent config

- One-time, user-scoped install (documented in the README):

```
claude mcp add --scope user maestro -- npx -y maestro-mcp
```

- Because the server resolves the board from cwd, this single install works in
  every workspace Maestro opens — no per-project `.mcp.json` writing by the app.
- Requires Node/npx on the machine — a given, since the agent CLIs themselves
  (claude, codex, gemini) are npm installs.
- Codex / Gemini / opencode: same binary works (`npx -y maestro-mcp` in their
  respective MCP config formats), but documented install is Claude Code only in v1.

### Concurrency & failure modes

- Two writers, one file: atomic rename prevents torn reads; read-before-write
  keeps the lost-update window to the span of a single mutation (milliseconds).
  A simultaneous UI click and MCP call can still race — last write wins; both
  sides re-converge on the next poll tick. Accepted for v1.
- MCP server never caches between tool calls — every call re-reads the file, so
  a long-lived agent session always sees UI edits.
- Corrupt/hand-edited board.json: MCP errors without writing; UI falls back to
  the default board in memory but does NOT write until the first user mutation
  (so a fixable file isn't silently destroyed). A console warning is logged.

### Testing

- `mcp/` package tests (vitest, temp dirs): board ops (add/update/move/delete,
  id-vs-title resolution, ambiguity errors, label/due validation), atomic write,
  default board materialisation, corrupt-file behaviour, `card_done` evidence
  with and without git.
- App TS tests (`src/kanban.test.ts`): file persistence path (mocked ipc),
  one-time migration from localStorage, external-change reload, dir-less fallback.
- Manual: spawn claude in a pane → `/mcp` lists `maestro` → `card_add` → card
  appears on the board within one poll tick; drag the card in the UI → agent's
  next `board_get` sees the move.

## Out of scope (v1)

- External agents (outside the app) — nothing prevents manually configuring
  maestro-mcp.exe elsewhere, but it isn't set up or documented.
- HTTP/SSE transport, realtime push (3.5s poll is enough).
- Auto-config for Codex / Gemini / opencode.
- Multi-board per workspace; cross-workspace moves.
- MCP resources/prompts — tools only.
