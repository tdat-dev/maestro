# maestro-mcp

MCP server for the [Maestro](https://github.com/tdat-dev/maestro) kanban board.
Lets an AI agent (Claude Code, etc.) read and edit the board of the workspace it
runs in — the same board the Maestro app renders. Source of truth is
`.maestro/board.json` in the workspace folder.

## Install (Claude Code)

One-time, user scope — works in every workspace because the server resolves the
board from the directory the agent runs in:

```
claude mcp add --scope user maestro -- npx -y maestro-mcp
```

On native Windows (not WSL), wrap the command with `cmd /c` — Claude Code's
MCP client spawns the server directly, and `npx` there is a `.cmd` shim that
needs a shell to resolve, so npx-based stdio servers require the wrapper:

```
claude mcp add --scope user maestro -- cmd /c npx -y maestro-mcp
```

From a local checkout (before the npm publish):

```
cd mcp && npm install && npm run build
claude mcp add --scope user maestro -- node <absolute path to mcp/dist/index.js>
```

## Tools

| Tool | What it does |
|------|--------------|
| `board_get` | Read the whole board (lists, cards, ids) |
| `card_add` | Add a card (`list`, `title`, `desc?`, `labels?`, `due?`, `checklist?`) |
| `card_update` | Patch a card's fields |
| `card_move` | Move a card to another list / position (moving into "Doing" claims the card for the calling agent) |
| `card_delete` | Delete a card |
| `card_done` | Move a card to Done + attach git change evidence and who finished it |
| `list_add` / `list_rename` / `list_delete` | Manage lists |
| `fleet_status` | List the other agents Maestro runs in this workspace + their live status (needs / active / idle / stopped) |
| `fleet_send` | Send a message into another agent's terminal (or broadcast to all) — for hand-offs and coordination |
| `agent_output` | Read the recent on-screen text of another agent (by name) — check a worker's progress or whether it's stuck |
| `agent_spawn` | Ask Maestro to spawn new worker agent(s) in this workspace — a conductor grows its own crew (with an optional task) |

Cards and lists are addressed by id (from `board_get`) or by title; ambiguous
titles are rejected with a hint to use the id. Labels:
`green | yellow | orange | red | purple | blue`. Due dates: `yyyy-mm-dd`.

## Agent identity

Maestro sets `MAESTRO_AGENT=<pane name>` (and `MAESTRO_WORKSPACE=<folder>`) in
every terminal it spawns. When present, `card_done` records it as `done.by`
and `card_move` into "Doing" sets it as the card's `assignee` (never
overwriting an existing one) — so the Maestro board shows which agent is
working on, and finished, each card.

## Fleet coordination

`fleet_status` and `fleet_send` let an agent see and message the rest of the
fleet through a file bridge (same idea as the board): Maestro publishes the
roster to `<workspace>/.maestro/fleet.json`, and `fleet_send` appends to
`<workspace>/.maestro/outbox.jsonl`, which Maestro watches and types into the
target agent's terminal. This is the substrate a "conductor" agent uses to
hand work to idle agents.

A conductor goes further with `agent_output` (read a worker's screen to see its
progress) and `agent_spawn` (grow its own crew): Maestro publishes each agent's
recent screen into `fleet.json`, and `agent_spawn` appends to
`.maestro/spawn-requests.jsonl`, which Maestro watches and boots the requested
CLI(s) into the same workspace.

## How it stays in sync

Every tool call re-reads `.maestro/board.json`, applies the change, and writes
it back atomically. The Maestro app watches the file and re-renders within a
few seconds; UI edits land in the same file, so the next tool call sees them.

## Limitations

The server resolves the board from its process's current working directory.
An agent Maestro spawned into an isolated git worktree (Maestro's worktree
isolation feature) has that worktree as its cwd, so by default it reads and
writes `<worktree>/.maestro/board.json` — a separate file from the main
workspace board shown in the Maestro kanban panel, not the same board.
Workaround: pass the workspace directory explicitly, e.g.
`maestro-mcp <dir>` (or `node dist/index.js <dir>` from a local checkout), so
the agent manages the same board.json the UI renders regardless of its cwd.
