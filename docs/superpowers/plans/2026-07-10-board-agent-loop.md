# Board ⇄ Agent Loop (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A kanban card can be dispatched to a specific running agent, the board shows who works on what, and Maestro notifies when an agent finishes a card.

**Architecture:** `card.assignee` rides in `.maestro/board.json` (shared file, both packages normalize it). Dispatch = compose a structured prompt from the card and type it into the chosen pane's PTY; agent identity flows the other way via a `MAESTRO_AGENT` env var set at spawn, which maestro-mcp stamps into `done.by` / claims as assignee on move-to-Doing. The UI learns about agent completions from the existing `pollBoardJson` reload by diffing Done-list membership.

**Tech Stack:** TypeScript (vanilla frontend, vitest), Rust (Tauri 2, portable-pty), Node ESM (maestro-mcp, zod, vitest).

**Spec:** `docs/superpowers/specs/2026-07-10-board-agent-loop-design.md`

## Global Constraints

- Board file stays `{"version": 2, "lists": [...]}` — `assignee`/`by` are additive optional fields; old boards must load unchanged.
- All shell commands run via `rtk` prefix (user rule), e.g. `rtk npm test`.
- App tests: `rtk npm test` + `rtk npx tsc --noEmit` at repo root. MCP tests: `rtk npm test` in `mcp/`. Rust: `rtk cargo check` in `src-tauri/`.
- Frontend is vanilla TS + per-feature CSS in `src/styles/` — no frameworks.
- Kanban drag uses Pointer Events, never HTML5 DnD (WebView2 swallows it).

---

### Task 1: `assignee` + `done.by` in the app board model

**Files:**
- Modify: `src/board.ts` (Card ~line 18-26, DoneInfo ~line 12-17, normalizeCard ~line 67-86)
- Test: `src/board.test.ts`

**Interfaces:**
- Produces: `Card.assignee?: string`, `DoneInfo.by?: string`, both surviving `normalizeCard`/`normalizeLists`. Later tasks (kanban UI, dispatch) rely on exactly these names.

- [ ] **Step 1: Write the failing test** — append to `src/board.test.ts`:

```ts
describe("assignee + done.by", () => {
  it("normalizeCard keeps a string assignee and done.by, drops non-strings", () => {
    const c = normalizeCard({
      title: "t",
      assignee: "Claude Code #1",
      done: { repoRoot: "r", files: ["a.ts"], at: 1, by: "Claude Code #1" },
    } as Partial<Card>);
    expect(c.assignee).toBe("Claude Code #1");
    expect(c.done?.by).toBe("Claude Code #1");
    const bad = normalizeCard({ title: "t", assignee: 42 as unknown as string });
    expect(bad.assignee).toBeUndefined();
  });

  it("legacy cards without assignee still normalize", () => {
    const c = normalizeCard({ title: "old" });
    expect(c.assignee).toBeUndefined();
  });
});
```

(Import `normalizeCard` and `type Card` in the test file's existing import from `./board` if missing.)

- [ ] **Step 2: Run to verify failure** — `rtk npx vitest run src/board.test.ts` → FAIL (assignee undefined vs expected / TS error).

- [ ] **Step 3: Implement** in `src/board.ts`:

```ts
export interface DoneInfo {
  repoRoot: string;
  files: string[];
  summary?: string;
  at: number;
  by?: string; // which agent finished it (MAESTRO_AGENT)
}
export interface Card {
  id: string;
  title: string;
  desc: string;
  labels: string[];
  due: string | null;
  checklist: ChecklistItem[];
  assignee?: string; // pane name of the agent working this card
  done?: DoneInfo;
}
```

In `normalizeCard`, after the `due` line add:

```ts
    checklist: Array.isArray(c.checklist) ? c.checklist : [],
  };
  if (typeof c.assignee === "string" && c.assignee.trim()) card.assignee = c.assignee;
```

and inside the `done` block:

```ts
      summary: typeof d.summary === "string" ? d.summary : undefined,
      at: typeof d.at === "number" ? d.at : 0,
      by: typeof d.by === "string" && d.by.trim() ? d.by : undefined,
```

- [ ] **Step 4: Verify** — `rtk npx vitest run src/board.test.ts` → PASS; `rtk npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit** — `rtk git add src/board.ts src/board.test.ts && rtk git commit -m "feat(board): assignee + done.by on cards"`

---

### Task 2: same fields in maestro-mcp's board model

**Files:**
- Modify: `mcp/src/board.ts` (Card ~19-27, DoneInfo ~13-18, normalizeCard ~60-87)
- Test: `mcp/src/board.test.ts` (new file)

**Interfaces:**
- Produces: identical `assignee?`/`by?` fields in the mcp package. Task 4 (`markDone` actor) consumes `DoneInfo.by`.

- [ ] **Step 1: Failing test** — create `mcp/src/board.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeBoard } from "./board.js";

describe("normalizeBoard assignee/by", () => {
  it("round-trips assignee and done.by, drops junk", () => {
    const b = normalizeBoard({
      lists: [
        {
          id: "l1",
          title: "Done",
          cards: [
            {
              id: "c1",
              title: "t",
              assignee: "Claude Code #1",
              done: { repoRoot: "r", files: [], at: 5, by: "Claude Code #1" },
            },
            { id: "c2", title: "junk", assignee: 9 },
          ],
        },
      ],
    });
    expect(b.lists[0].cards[0].assignee).toBe("Claude Code #1");
    expect(b.lists[0].cards[0].done?.by).toBe("Claude Code #1");
    expect(b.lists[0].cards[1].assignee).toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify failure** — `cd mcp` then `rtk npx vitest run src/board.test.ts` → FAIL.

- [ ] **Step 3: Implement** in `mcp/src/board.ts` — mirror Task 1 exactly:

```ts
export interface DoneInfo {
  repoRoot: string;
  files: string[];
  summary?: string;
  at: number;
  by?: string;
}
export interface Card {
  id: string;
  title: string;
  desc: string;
  labels: string[];
  due: string | null;
  checklist: ChecklistItem[];
  assignee?: string;
  done?: DoneInfo;
}
```

In `normalizeCard` after the checklist field:

```ts
  if (typeof c.assignee === "string" && c.assignee.trim()) card.assignee = c.assignee;
```

and in the `done` block:

```ts
      by: typeof (d as DoneInfo).by === "string" && (d as DoneInfo).by!.trim() ? (d as DoneInfo).by : undefined,
```

- [ ] **Step 4: Verify** — in `mcp/`: `rtk npm test` → PASS; `rtk npm run build` → clean.

- [ ] **Step 5: Commit** — `rtk git add mcp/src/board.ts mcp/src/board.test.ts && rtk git commit -m "feat(mcp): assignee + done.by in board model"`

---

### Task 3: `MAESTRO_AGENT` env through spawn (Rust → ipc → main)

**Files:**
- Modify: `src-tauri/src/commands.rs` (`pty_spawn`, lines 22-41)
- Modify: `src/ipc.ts` (`spawnPty`, lines 20-35)
- Modify: `src/main.ts` (spawnPty call, ~line 1120)
- Test: `src/ipc.test.ts` (spawnPty test, ~line 27)

**Interfaces:**
- Consumes: `CommandSpec.env: Vec<(String, String)>` (already exists in `src-tauri/src/core/command_spec.rs` and is applied in `pty_session.rs`).
- Produces: `spawnPty(agentId, program, args, cwd, cols, rows, env, onBytes)` where `env: Array<[string, string]>`. Every spawned agent gets `MAESTRO_AGENT=<pane name>` and `MAESTRO_WORKSPACE=<cwd or "">`.

- [ ] **Step 1: Failing test** — update the spawnPty test in `src/ipc.test.ts`:

```ts
it("spawnPty passes agentId, cwd, env + camelCase args including the channel", async () => {
  await spawnPty("agent-1", "powershell.exe", ["-NoLogo"], "D:\\projects\\demo", 80, 24,
    [["MAESTRO_AGENT", "Claude Code #1"]], () => {});
  expect(invoke).toHaveBeenCalledWith(
    "pty_spawn",
    expect.objectContaining({
      agentId: "agent-1",
      program: "powershell.exe",
      args: ["-NoLogo"],
      cwd: "D:\\projects\\demo",
      cols: 80,
      env: [["MAESTRO_AGENT", "Claude Code #1"]],
    }),
  );
});
```

- [ ] **Step 2: Verify failure** — `rtk npx vitest run src/ipc.test.ts` → FAIL (arg count / env missing).

- [ ] **Step 3: Implement.** `src/ipc.ts`:

```ts
export async function spawnPty(
  agentId: string,
  program: string,
  args: string[],
  cwd: string | null,
  cols: number,
  rows: number,
  env: Array<[string, string]>,
  onBytes: (bytes: Uint8Array) => void,
): Promise<void> {
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (buf) => onBytes(new Uint8Array(buf));
  await invoke("pty_spawn", { agentId, program, args, cwd, cols, rows, env, onBytes: ch });
}
```

`src-tauri/src/commands.rs` — add the parameter after `cwd` and apply it:

```rust
    cwd: Option<String>,
    env: Option<Vec<(String, String)>>,
    cols: u16,
    rows: u16,
```

and after `spec.cwd = cwd.filter(|s| !s.is_empty());`:

```rust
    spec.env = env.unwrap_or_default();
```

`src/main.ts` at the spawn site (~1120) — pass the pane's identity (there is exactly one spawnPty call):

```ts
      const envPairs: Array<[string, string]> = [
        ["MAESTRO_AGENT", spec.name],
        ["MAESTRO_WORKSPACE", cwd ?? ""],
      ];
      await spawnPty(id, launch.program, launch.args, cwd, cols, rows, envPairs, (bytes) => {
```

- [ ] **Step 4: Verify** — `rtk npx vitest run src/ipc.test.ts` → PASS; `rtk npx tsc --noEmit` → clean; in `src-tauri/`: `rtk cargo check` → clean.

- [ ] **Step 5: Commit** — `rtk git add src-tauri/src/commands.rs src/ipc.ts src/ipc.test.ts src/main.ts && rtk git commit -m "feat: MAESTRO_AGENT/MAESTRO_WORKSPACE env on every agent spawn"`

---

### Task 4: maestro-mcp records the actor (done.by, claim-on-move)

**Files:**
- Modify: `mcp/src/ops.ts` (`markDone` ~159-175, `moveCard` ~121-131)
- Modify: `mcp/src/server.ts` (`card_done` ~134-146, `card_move` ~107-119)
- Test: `mcp/src/ops.test.ts` (new file)

**Interfaces:**
- Consumes: `DoneInfo.by` from Task 2.
- Produces: `markDone(board, cardRef, evidence)` where evidence gains `by?: string`; `moveCard(board, cardRef, toListRef, position?, actor?)` — moving to a list titled "Doing" sets `card.assignee = actor` when the card has none.

- [ ] **Step 1: Failing test** — create `mcp/src/ops.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultBoard } from "./board.js";
import { addCard, markDone, moveCard } from "./ops.js";

describe("actor identity", () => {
  it("markDone stamps done.by", () => {
    const b = defaultBoard();
    addCard(b, "To do", { title: "fix bug" });
    const card = markDone(b, "fix bug", { repoRoot: "r", files: [], by: "Claude Code #1" });
    expect(card.done?.by).toBe("Claude Code #1");
  });

  it("moveCard to Doing claims an unassigned card for the actor", () => {
    const b = defaultBoard();
    addCard(b, "To do", { title: "fix bug" });
    const card = moveCard(b, "fix bug", "Doing", undefined, "Claude Code #1");
    expect(card.assignee).toBe("Claude Code #1");
  });

  it("moveCard never overwrites an existing assignee", () => {
    const b = defaultBoard();
    const c = addCard(b, "To do", { title: "fix bug" });
    c.assignee = "Codex #1";
    moveCard(b, "fix bug", "Doing", undefined, "Claude Code #1");
    expect(c.assignee).toBe("Codex #1");
  });

  it("moveCard to a non-Doing list does not claim", () => {
    const b = defaultBoard();
    addCard(b, "To do", { title: "fix bug" });
    const card = moveCard(b, "fix bug", "Done", undefined, "Claude Code #1");
    expect(card.assignee).toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify failure** — in `mcp/`: `rtk npx vitest run src/ops.test.ts` → FAIL (signature/behaviour).

- [ ] **Step 3: Implement** in `mcp/src/ops.ts`:

```ts
export function moveCard(
  board: Board,
  cardRef: string,
  toListRef: string,
  position?: number,
  actor?: string,
): Card {
  const found = resolveCard(board, cardRef);
  const target = resolveOrCreateList(board, toListRef);
  found.list.cards.splice(found.idx, 1);
  const pos =
    position === undefined
      ? target.cards.length
      : Math.max(0, Math.min(position, target.cards.length));
  target.cards.splice(pos, 0, found.card);
  // An agent moving a card into Doing claims it (never steals an assignment).
  if (actor && !found.card.assignee && norm(target.title) === "doing")
    found.card.assignee = actor;
  return found.card;
}
```

```ts
export function markDone(
  board: Board,
  cardRef: string,
  evidence: { repoRoot: string; files: string[]; summary?: string; by?: string },
): Card {
  const found = resolveCard(board, cardRef);
  const done = resolveOrCreateList(board, "Done");
  found.list.cards.splice(found.idx, 1);
  done.cards.push(found.card);
  found.card.done = {
    repoRoot: evidence.repoRoot,
    files: evidence.files,
    summary: evidence.summary,
    at: Date.now(),
    by: evidence.by,
  };
  return found.card;
}
```

In `mcp/src/server.ts`, inside `createServer` (top of function body):

```ts
  const agentName = process.env.MAESTRO_AGENT?.trim() || undefined;
```

`card_move` handler:

```ts
    async ({ card, to_list, position }) =>
      mutate((b) => moveCard(b, card, to_list, position, agentName)),
```

`card_done` handler:

```ts
    async ({ card, summary }) =>
      mutate((b) => markDone(b, card, { repoRoot: dir, files: changedFiles(dir), summary, by: agentName })),
```

- [ ] **Step 4: Verify** — in `mcp/`: `rtk npm test` → PASS; `rtk npm run build` → clean.

- [ ] **Step 5: Commit** — `rtk git add mcp/src/ops.ts mcp/src/ops.test.ts mcp/src/server.ts && rtk git commit -m "feat(mcp): record acting agent — done.by + claim on move-to-Doing"`

---

### Task 5: dispatch prompt module

**Files:**
- Create: `src/dispatch.ts`
- Modify: `src/kanban.ts` (move `cardToAgentText`, lines 121-131, into dispatch.ts; re-export)
- Test: `src/dispatch.test.ts` (new)

**Interfaces:**
- Consumes: `Card` from `./board`.
- Produces: `cardToAgentText(card): string` (moved, same behaviour) and `dispatchPrompt(card): string`. `kanban.ts` re-exports `cardToAgentText` so existing imports/tests keep working.

- [ ] **Step 1: Failing test** — create `src/dispatch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dispatchPrompt } from "./dispatch";
import { mkCard } from "./board";

describe("dispatchPrompt", () => {
  it("contains the task text and the board-tool instructions", () => {
    const card = mkCard("Fix login bug");
    card.desc = "Session cookie expires too early";
    card.checklist = [{ id: "i1", text: "add test", done: false }];
    const p = dispatchPrompt(card);
    expect(p).toContain("Task: Fix login bug");
    expect(p).toContain("Session cookie expires too early");
    expect(p).toContain("- [ ] add test");
    expect(p).toContain('card_move');
    expect(p).toContain('"Doing"');
    expect(p).toContain("card_done");
    expect(p).toContain("Fix login bug");
  });
});
```

- [ ] **Step 2: Verify failure** — `rtk npx vitest run src/dispatch.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `src/dispatch.ts`:

```ts
/* Structured dispatch: turn a kanban card into the prompt typed into an
 * agent's terminal. Pure (no DOM/IPC) so it stays unit-testable. */

import type { Card } from "./board";

/** Plain task text: title, description, open checklist items. */
export function cardToAgentText(card: Card): string {
  const lines = [`Task: ${card.title.trim()}`];
  const desc = card.desc.trim();
  if (desc) lines.push("", desc);
  const todo = card.checklist.filter((i) => !i.done);
  if (todo.length) {
    lines.push("");
    for (const i of todo) lines.push(`- [ ] ${i.text}`);
  }
  return lines.join("\n");
}

/** Full dispatch prompt: the task plus board-reporting instructions. Agents
 *  with the maestro MCP tools keep the board in step; agents without them
 *  just do the task. */
export function dispatchPrompt(card: Card): string {
  return (
    cardToAgentText(card) +
    "\n\n" +
    `When you start, move this card to "Doing" with the maestro MCP tool ` +
    `card_move (card: ${JSON.stringify(card.title.trim())}). When finished, call ` +
    `card_done (card: ${JSON.stringify(card.title.trim())}) with a one-line summary. ` +
    `If you don't have maestro tools, just do the task.`
  );
}
```

In `src/kanban.ts`: delete the local `cardToAgentText` (lines 121-131) and add to the imports/exports:

```ts
import { cardToAgentText, dispatchPrompt } from "./dispatch";
export { cardToAgentText } from "./dispatch";
```

- [ ] **Step 4: Verify** — `rtk npx vitest run src/dispatch.test.ts src/kanban.test.ts` → PASS; `rtk npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit** — `rtk git add src/dispatch.ts src/dispatch.test.ts src/kanban.ts && rtk git commit -m "feat: dispatch prompt composer (card -> agent instructions)"`

---

### Task 6: agentbridge fleet hooks + main.ts registration

**Files:**
- Modify: `src/agentbridge.ts`
- Modify: `src/main.ts` (registration block ~2728-2770, `setPaneTargeting` ~2753)
- Modify: `src/kanban.ts` (drop-callsite, ~line 687 — adapt to new drop return type)

**Interfaces:**
- Produces (consumed by Task 7's UI):
  - `interface AgentInfo { id: string; name: string; color: string; running: boolean }`
  - `listAgents(): AgentInfo[]` — running panes of the ACTIVE workspace
  - `sendToAgentById(id: string, text: string, submit: boolean): boolean`
  - `focusPane(id: string): boolean` — focuses that pane's terminal
  - `PaneTargeting.drop` now returns `AgentInfo | null` (was boolean) — `dropTextIntoPaneAt` likewise.

- [ ] **Step 1: Extend `src/agentbridge.ts`** — add below the existing sender section:

```ts
/* ---- fleet directory: the board's agent picker + assignee chips ---- */

export interface AgentInfo {
  id: string;
  name: string;
  color: string;
  running: boolean;
}

let fleet: (() => AgentInfo[]) | null = null;
let senderById: ((id: string, text: string, submit: boolean) => boolean) | null = null;
let paneFocuser: ((id: string) => boolean) | null = null;

export function setFleet(fn: () => AgentInfo[]): void {
  fleet = fn;
}
export function listAgents(): AgentInfo[] {
  return fleet ? fleet() : [];
}
export function setAgentSenderById(fn: (id: string, text: string, submit: boolean) => boolean): void {
  senderById = fn;
}
export function sendToAgentById(id: string, text: string, submit: boolean): boolean {
  return senderById ? senderById(id, text, submit) : false;
}
export function setPaneFocuser(fn: (id: string) => boolean): void {
  paneFocuser = fn;
}
export function focusPane(id: string): boolean {
  return paneFocuser ? paneFocuser(id) : false;
}
```

and change the targeting drop contract:

```ts
export interface PaneTargeting {
  hover(x: number, y: number): boolean;
  clear(): void;
  /** Type `text` into the PTY of the pane under (x, y) — no Enter; the hit
   *  pane's identity on success, null on miss. */
  drop(x: number, y: number, text: string): AgentInfo | null;
}
```

```ts
export function dropTextIntoPaneAt(x: number, y: number, text: string): AgentInfo | null {
  return paneTargeting ? paneTargeting.drop(x, y, text) : null;
}
```

- [ ] **Step 2: Register in `src/main.ts`** — extend the import from "./agentbridge" with `setFleet, setAgentSenderById, setPaneFocuser`, then after the existing `setAgentSender(...)` block (~2749):

```ts
// Fleet directory for the board: running panes of the active workspace.
setFleet(() =>
  activeWs
    ? [...activeWs.panes.values()].map((p) => ({
        id: p.id,
        name: p.spec.name,
        color: p.color,
        running: p.running,
      }))
    : [],
);
setAgentSenderById((id, text, submit) => {
  const pane = activeWs?.panes.get(id);
  if (!pane || !pane.running) return false;
  void sendInput(pane.id, text + (submit ? "\r" : "")).catch(() => {});
  pane.term.focus();
  return true;
});
setPaneFocuser((id) => {
  const pane = activeWs?.panes.get(id);
  if (!pane) return false;
  pane.term.focus();
  pane.el.scrollIntoView({ block: "nearest" });
  return true;
});
```

and update the `setPaneTargeting` drop to return the pane's identity:

```ts
  drop: (x, y, text) => {
    const target = paneAtClient(x, y) ?? dropTarget;
    setDropTarget(null);
    if (!target || !text) return null;
    void sendInput(target.id, text).catch(() => {});
    target.term.focus();
    return { id: target.id, name: target.spec.name, color: target.color, running: target.running };
  },
```

(Keep whatever the current drop body does around `sendInput` — only the return value changes from boolean to `AgentInfo | null`.)

- [ ] **Step 3: Adapt the kanban callsite** (`src/kanban.ts` ~687) — the truthiness check still works, but capture the result for Task 7:

```ts
    if (overPane && cardId) {
      const found = findCard(cardId);
      const hit = found ? dropTextIntoPaneAt(e.clientX, e.clientY, dispatchPrompt(found.card)) : null;
      if (!hit) clearPaneTarget();
      hidePill();
      render();
      return;
    }
```

- [ ] **Step 4: Verify** — `rtk npx tsc --noEmit` → clean; `rtk npm test` → PASS.

- [ ] **Step 5: Commit** — `rtk git add src/agentbridge.ts src/main.ts src/kanban.ts && rtk git commit -m "feat: fleet directory + per-pane send/focus hooks for the board"`

---

### Task 7: dispatch UI — send-to-agent picker, assignee on drop, assignee chip

**Files:**
- Modify: `src/kanban.ts` (cardFace ~782-853, renderDetail ~987-1114, drop-callsite from Task 6)
- Modify: `src/styles/kanban.css` (chip + picker styles)

**Interfaces:**
- Consumes: `listAgents`, `sendToAgentById`, `focusPane`, `AgentInfo` (Task 6); `dispatchPrompt` (Task 5); `card.assignee` (Task 1).
- Produces: `assignCard(cardId, name, moveToDoing)` internal helper reused by both dispatch paths.

- [ ] **Step 1: Board mutation helper** — add near the other mutations (~line 760) in `src/kanban.ts`:

```ts
  const DOING_TITLE = "Doing";
  /** Record who a card is dispatched to; optionally pull it into Doing. */
  function assignCard(cardId: string, name: string | undefined, moveToDoing: boolean): void {
    void withBoard((b) => {
      const found = findCardIn(b, cardId);
      if (!found) return;
      found.card.assignee = name;
      if (moveToDoing && found.list.title.toLowerCase() !== DOING_TITLE.toLowerCase()) {
        const doing = findOrCreateListIn(b, DOING_TITLE);
        found.list.cards.splice(found.idx, 1);
        doing.cards.push(found.card);
      }
    });
  }
```

- [ ] **Step 2: Drop path assigns** — extend the Task 6 callsite:

```ts
    if (overPane && cardId) {
      const found = findCard(cardId);
      const hit = found ? dropTextIntoPaneAt(e.clientX, e.clientY, dispatchPrompt(found.card)) : null;
      if (hit) assignCard(cardId, hit.name, true);
      else clearPaneTarget();
      hidePill();
      render();
      return;
    }
```

(Imports: add `listAgents`, `sendToAgentById`, `focusPane` to the "./agentbridge" import.)

- [ ] **Step 3: Assignee chip on the card face** — in `cardFace`, before `doneFooter`:

```ts
    const assignee = card.assignee
      ? `<button class="kb-assignee" title="Focus this agent's pane">⚡ ${enc(card.assignee)}</button>`
      : "";
```

include it in the innerHTML between title and badges:

```ts
    node.innerHTML =
      labels +
      `<span class="kb-card-title">${enc(card.title)}</span>` +
      assignee +
      (badges.length ? `<div class="kb-badges">${badges.join("")}</div>` : "") +
      doneFooter;
```

and in the click handler, before the `.kb-file` branch:

```ts
      const chip = (e.target as HTMLElement).closest<HTMLElement>(".kb-assignee");
      if (chip) {
        e.stopPropagation();
        const agent = listAgents().find((a) => a.name === card.assignee);
        if (agent) focusPane(agent.id);
        return;
      }
```

- [ ] **Step 4: Detail view — Agent section** — in `renderDetail`, after the `due` section build:

```ts
    // agent assignment + dispatch
    const agentSec = el("div", "kb-section");
    agentSec.innerHTML = `<span class="kb-sec-l">Agent</span>`;
    const agentRow = el("div", "kb-agent-row");
    if (card.assignee) {
      const chip = el("button", "kb-assignee big", `⚡ ${enc(card.assignee)}`);
      chip.title = "Focus this agent's pane";
      chip.addEventListener("click", () => {
        const a = listAgents().find((x) => x.name === card.assignee);
        if (a) focusPane(a.id);
      });
      const clear = el("button", "kb-due-clear", "Unassign");
      clear.addEventListener("click", () => assignCard(card.id, undefined, false));
      agentRow.append(chip, clear);
    }
    const running = listAgents().filter((a) => a.running);
    if (running.length) {
      const sel = document.createElement("select");
      sel.className = "kb-agent-pick";
      sel.innerHTML =
        `<option value="">Send to agent…</option>` +
        running.map((a) => `<option value="${enc(a.id)}">${enc(a.name)}</option>`).join("");
      sel.addEventListener("change", () => {
        const a = running.find((x) => x.id === sel.value);
        if (!a) return;
        if (sendToAgentById(a.id, dispatchPrompt(card), true)) {
          assignCard(card.id, a.name, true);
        }
        sel.value = "";
      });
      agentRow.appendChild(sel);
    } else if (!card.assignee) {
      agentRow.appendChild(el("span", "kb-agent-none", "No running agents"));
    }
    agentSec.appendChild(agentRow);
```

and mount it: `view.append(back, title, labels, due, agentSec, desc, cl, del);`

- [ ] **Step 5: Styles** — append to `src/styles/kanban.css`:

```css
/* agent assignment */
.kb-assignee{display:inline-flex;align-items:center;gap:4px;margin-top:6px;padding:2px 8px;
  border:1px solid rgba(198,241,53,.35);border-radius:999px;background:rgba(198,241,53,.08);
  color:#c6f135;font-size:11px;cursor:pointer;max-width:100%;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.kb-assignee:hover{background:rgba(198,241,53,.16)}
.kb-assignee.big{font-size:12px;padding:4px 10px;margin-top:0}
.kb-agent-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kb-agent-pick{background:#161b22;color:#e8edf2;border:1px solid #2a323c;border-radius:6px;
  padding:5px 8px;font-size:12px}
.kb-agent-none{color:#7d8b99;font-size:12px}
```

(Match the file's existing colour tokens if they differ — reuse whatever variables `kanban.css` already uses for surfaces/borders.)

- [ ] **Step 6: Verify** — `rtk npx tsc --noEmit` → clean; `rtk npm test` → PASS. Manual smoke: `rtk npm run tauri dev`, open board (Ctrl+Shift+K), card detail shows Agent section; dispatch to a running shell pane types the prompt.

- [ ] **Step 7: Commit** — `rtk git add src/kanban.ts src/styles/kanban.css && rtk git commit -m "feat(ui): send-to-agent dispatch + assignee chip on board cards"`

---

### Task 8: notify when an agent finishes a card

**Files:**
- Modify: `src/board.ts` (new pure helper `doneCardIds`)
- Modify: `src/kanban.ts` (`pollBoardJson` ~393-415, toast helper)
- Modify: `src/styles/kanban.css`
- Test: `src/board.test.ts`

**Interfaces:**
- Consumes: `notify(title, body)` from `./ipc` (already imported by kanban.ts? if not, add); `DONE_TITLE` constant already in kanban.ts.
- Produces: `doneCardIds(board): Set<string>` in `src/board.ts`.

- [ ] **Step 1: Failing test** — append to `src/board.test.ts`:

```ts
describe("doneCardIds", () => {
  it("collects ids of cards in any list titled Done (case-insensitive)", () => {
    const b: Board = {
      lists: [
        { id: "l1", title: "To do", cards: [normalizeCard({ id: "a", title: "a" })] },
        { id: "l2", title: "DONE", cards: [normalizeCard({ id: "b", title: "b" })] },
      ],
    };
    expect([...doneCardIds(b)]).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Verify failure** — `rtk npx vitest run src/board.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `src/board.ts`:

```ts
/** Ids of every card sitting in a list titled "Done" (any case). */
export function doneCardIds(board: Board): Set<string> {
  const out = new Set<string>();
  for (const l of board.lists)
    if (l.title.trim().toLowerCase() === "done")
      for (const c of l.cards) out.add(c.id);
  return out;
}
```

- [ ] **Step 4: Wire into `pollBoardJson`** (`src/kanban.ts`) — import `doneCardIds` from "./board" and `notify` from "./ipc"; add a tiny toast helper near `showPill`:

```ts
  /** Transient bottom-right toast (agent finished a card). */
  function kbToast(text: string): void {
    const t = el("div", "kb-toast", enc(text));
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("on"));
    window.setTimeout(() => {
      t.classList.remove("on");
      window.setTimeout(() => t.remove(), 400);
    }, 4000);
  }
```

then in `pollBoardJson`, diff Done membership across the external reload:

```ts
    try {
      const bf = await readBoardFile(dir);
      if (!bf) return;
      const before = doneCardIds(board);
      board = bf.board;
      boardMtime = bf.mtime;
      for (const l of board.lists) {
        if (l.title.trim().toLowerCase() !== "done") continue;
        for (const c of l.cards) {
          if (before.has(c.id)) continue;
          const who = c.done?.by ?? c.assignee ?? "agent";
          kbToast(`✅ ${who} finished: ${c.title}`);
          if (!document.hasFocus()) void notify(`${who} finished a task`, c.title).catch(() => {});
        }
      }
      rerender();
      scheduleBoardFile();
    } catch {
```

- [ ] **Step 5: Toast styles** — append to `src/styles/kanban.css`:

```css
.kb-toast{position:fixed;right:18px;bottom:18px;z-index:9999;max-width:340px;
  padding:10px 14px;border-radius:10px;background:#161b22;border:1px solid #2a323c;
  color:#e8edf2;font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.45);
  opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s;pointer-events:none}
.kb-toast.on{opacity:1;transform:translateY(0)}
```

- [ ] **Step 6: Verify** — `rtk npx vitest run src/board.test.ts` → PASS; `rtk npx tsc --noEmit` → clean; `rtk npm test` → PASS.

- [ ] **Step 7: Commit** — `rtk git add src/board.ts src/board.test.ts src/kanban.ts src/styles/kanban.css && rtk git commit -m "feat(ui): toast + OS notification when an agent moves a card to Done"`

---

### Task 9: docs + changelog

**Files:**
- Modify: `mcp/README.md` (tools table + new "Agent identity" section)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Modify: `README.md` (MCP section, one sentence)

- [ ] **Step 1: mcp/README.md** — update the `card_move` / `card_done` rows and add after the tools table:

```markdown
| `card_move` | Move a card to another list / position (moving into "Doing" claims the card for the calling agent) |
| `card_done` | Move a card to Done + attach git change evidence and who finished it |

## Agent identity

Maestro sets `MAESTRO_AGENT=<pane name>` (and `MAESTRO_WORKSPACE=<folder>`) in
every terminal it spawns. When present, `card_done` records it as `done.by`
and `card_move` into "Doing" sets it as the card's `assignee` (never
overwriting an existing one) — so the Maestro board shows which agent is
working on, and finished, each card.
```

- [ ] **Step 2: CHANGELOG.md** under `## [Unreleased]`:

```markdown
### Added

- **Board ⇄ Agent loop** — kanban cards can be dispatched to a specific
  running agent ("Send to agent…" in the card detail, or drag the card onto a
  pane): the agent receives a structured prompt, the card records its
  `assignee` and jumps to Doing, and the card shows a clickable agent chip.
  Maestro sets `MAESTRO_AGENT` on every spawn so maestro-mcp records who
  moved/finished each card, and the app toasts (+ OS notification when
  unfocused) when an agent lands a card in Done.
```

- [ ] **Step 3: README.md** — in the MCP section, extend the paragraph:

```markdown
Dispatch works the other way too: send a card to a specific agent from the
board (it records the assignee and reports back when the agent marks it done).
```

- [ ] **Step 4: Commit** — `rtk git add mcp/README.md CHANGELOG.md README.md && rtk git commit -m "docs: board-agent dispatch + MAESTRO_AGENT identity"`

---

## Final verification

- [ ] `rtk npm test` (root) → all PASS
- [ ] `rtk npx tsc --noEmit` → clean
- [ ] in `mcp/`: `rtk npm test` + `rtk npm run build` → PASS/clean
- [ ] in `src-tauri/`: `rtk cargo check` → clean
- [ ] Manual: `rtk npm run tauri dev` → spawn a `claude` agent (with maestro-mcp installed) → dispatch a card → agent moves it to Doing (chip appears) → `card_done` → toast + chip `done.by`.
