# Maestro MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents in Maestro panes manage the workspace kanban board through an MCP server (`npx maestro-mcp`) whose source of truth is `.maestro/board.json`, which the Maestro UI also reads/writes.

**Architecture:** A new Node/TS package in `mcp/` implements a stdio MCP server (official `@modelcontextprotocol/sdk`) that does read → mutate → atomic-write on `.maestro/board.json` per tool call, resolving the workspace from cwd. The app side moves kanban persistence from localStorage to the same file (one-time migration), re-reading before every mutation and reloading on mtime change via the existing 3.5s watch loop.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`, vitest, Node ≥18. App side: existing Tauri IPC fs commands (`fsReadFile`/`fsWriteFile`/`fsStat`/`fsCreateFile`/`fsCreateDir`).

**Spec:** `docs/superpowers/specs/2026-07-03-maestro-mcp-design.md`

## Global Constraints

- Windows host; prefix every shell command with `rtk` (per user's RTK.md), e.g. `rtk npm test`.
- Work on branch `feat/maestro-mcp` (created in Task 1 off the current branch). Commit ONLY files this plan touches — the working tree has unrelated dirty files; never `git add -A`.
- `mcp/` package: runtime deps EXACTLY `@modelcontextprotocol/sdk` + `zod`; `engines.node >= 18`.
- App (`src/`): no new npm dependencies.
- board.json shape: `{ "version": 2, "lists": [...] }`; the `lists` entries match the existing `Board` type in `src/kanban.ts`.
- Label keys: exactly `green|yellow|orange|red|purple|blue`. Due dates: `yyyy-mm-dd` or null.
- The MCP server never caches between tool calls and never overwrites a corrupt board.json.
- App relative path for the board file is `".maestro\\board.json"` (backslash, matching PLAN_REL/DONE_REL style in kanban.ts). The mcp package uses `path.join(dir, ".maestro", "board.json")`.

---

### Task 1: `mcp/` package scaffold + board store (load/save)

**Files:**
- Create: `mcp/package.json`
- Create: `mcp/tsconfig.json`
- Create: `mcp/.gitignore`
- Create: `mcp/src/board.ts`
- Test: `mcp/test/board.test.ts`
- Modify: `vite.config.ts` (exclude `mcp/**` from the root vitest run)

**Interfaces:**
- Consumes: nothing (first task).
- Produces (used by Tasks 2–4):
  - Types `ChecklistItem`, `DoneInfo`, `Card`, `List`, `Board`
  - `class BoardError extends Error`
  - `const LABELS: string[]`
  - `uid(prefix: string): string`
  - `defaultBoard(): Board`
  - `normalizeBoard(raw: unknown): Board` (throws `BoardError` on wrong shape)
  - `boardPath(dir: string): string`
  - `loadBoard(dir: string): Board` (missing file → `defaultBoard()`; invalid JSON/shape → throws `BoardError`)
  - `saveBoard(dir: string, board: Board): void` (atomic tmp+rename, creates `.maestro/`)

- [ ] **Step 1: Create the branch**

```bash
rtk git checkout -b feat/maestro-mcp
```

- [ ] **Step 2: Scaffold the package**

Create `mcp/package.json`:

```json
{
  "name": "maestro-mcp",
  "version": "0.1.0",
  "description": "MCP server for the Maestro kanban board (.maestro/board.json)",
  "license": "MIT",
  "author": "tdat-dev",
  "repository": {
    "type": "git",
    "url": "https://github.com/tdat-dev/maestro.git",
    "directory": "mcp"
  },
  "type": "module",
  "bin": { "maestro-mcp": "dist/index.js" },
  "files": ["dist"],
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "prepublishOnly": "npm run build && npm test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.17.0",
    "zod": "^3.25.1"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.2",
    "vitest": "^3.2.4"
  }
}
```

Create `mcp/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

Create `mcp/.gitignore`:

```
node_modules/
dist/
```

Install:

```bash
rtk npm --prefix mcp install
```

- [ ] **Step 3: Keep the root test run away from mcp/**

Replace `vite.config.ts` content with:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Tauri expects a fixed dev-server port (matches devUrl in tauri.conf.json).
// 1430, not Tauri's default 1420: Windows winnat/Hyper-V reserves shifting port
// blocks (e.g. 1324-1423) and EACCES-blocks listening inside them.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
  test: {
    // mcp/ is its own package with its own vitest; .claude/ holds worktree copies.
    exclude: ["**/node_modules/**", "**/dist/**", "mcp/**", ".claude/**"],
  },
});
```

Run `rtk npm test` (root). Expected: same tests pass as before, none picked up from `mcp/`.

- [ ] **Step 4: Write the failing board-store tests**

Create `mcp/test/board.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadBoard,
  saveBoard,
  boardPath,
  defaultBoard,
  normalizeBoard,
  BoardError,
  uid,
  type Board,
} from "../src/board.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-mcp-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("uid", () => {
  it("prefixes and never repeats", () => {
    const a = uid("c");
    const b = uid("c");
    expect(a.startsWith("c")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("loadBoard", () => {
  it("returns the default 3-list board when board.json is missing", () => {
    const b = loadBoard(dir);
    expect(b.lists.map((l) => l.title)).toEqual(["To do", "Doing", "Done"]);
  });

  it("round-trips through saveBoard", () => {
    const b = defaultBoard();
    b.lists[0].cards.push({
      id: uid("c"),
      title: "hello",
      desc: "",
      labels: ["blue"],
      due: null,
      checklist: [],
    });
    saveBoard(dir, b);
    const again = loadBoard(dir);
    expect(again.lists[0].cards[0].title).toBe("hello");
    expect(again.lists[0].cards[0].labels).toEqual(["blue"]);
  });

  it("writes the versioned wrapper", () => {
    saveBoard(dir, defaultBoard());
    const raw = JSON.parse(fs.readFileSync(boardPath(dir), "utf8"));
    expect(raw.version).toBe(2);
    expect(Array.isArray(raw.lists)).toBe(true);
  });

  it("throws BoardError on invalid JSON and leaves the file untouched", () => {
    fs.mkdirSync(path.join(dir, ".maestro"), { recursive: true });
    fs.writeFileSync(boardPath(dir), "{not json", "utf8");
    expect(() => loadBoard(dir)).toThrow(BoardError);
    expect(fs.readFileSync(boardPath(dir), "utf8")).toBe("{not json");
  });

  it("throws BoardError when lists is missing", () => {
    fs.mkdirSync(path.join(dir, ".maestro"), { recursive: true });
    fs.writeFileSync(boardPath(dir), JSON.stringify({ version: 2 }), "utf8");
    expect(() => loadBoard(dir)).toThrow(BoardError);
  });
});

describe("normalizeBoard", () => {
  it("fills defaults for sparse cards", () => {
    const b: Board = normalizeBoard({
      lists: [{ id: "l1", title: "T", cards: [{ id: "c1", title: "x" }] }],
    });
    const c = b.lists[0].cards[0];
    expect(c.desc).toBe("");
    expect(c.labels).toEqual([]);
    expect(c.due).toBeNull();
    expect(c.checklist).toEqual([]);
    expect(c.done).toBeUndefined();
  });

  it("keeps done evidence when well-formed", () => {
    const b = normalizeBoard({
      lists: [
        {
          id: "l1",
          title: "Done",
          cards: [
            {
              id: "c1",
              title: "x",
              done: { repoRoot: "r", files: ["a.ts"], summary: "s", at: 5 },
            },
          ],
        },
      ],
    });
    expect(b.lists[0].cards[0].done).toEqual({
      repoRoot: "r",
      files: ["a.ts"],
      summary: "s",
      at: 5,
    });
  });
});

describe("saveBoard", () => {
  it("creates .maestro/ on first write and leaves no tmp file", () => {
    saveBoard(dir, defaultBoard());
    expect(fs.existsSync(boardPath(dir))).toBe(true);
    const leftovers = fs
      .readdirSync(path.join(dir, ".maestro"))
      .filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

```bash
rtk npm --prefix mcp test
```

Expected: FAIL — cannot resolve `../src/board.js`.

- [ ] **Step 6: Implement `mcp/src/board.ts`**

```ts
/* Board store for maestro-mcp: the .maestro/board.json shapes shared with the
 * Maestro app (src/kanban.ts), plus load/save. Every tool call re-reads the
 * file — no caching — and writes atomically (tmp + rename). */

import fs from "node:fs";
import path from "node:path";

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}
export interface DoneInfo {
  repoRoot: string;
  files: string[];
  summary?: string;
  at: number;
}
export interface Card {
  id: string;
  title: string;
  desc: string;
  labels: string[];
  due: string | null;
  checklist: ChecklistItem[];
  done?: DoneInfo;
}
export interface List {
  id: string;
  title: string;
  cards: Card[];
}
export interface Board {
  lists: List[];
}

/** User-facing failure (bad input, missing card, corrupt file). The MCP layer
 *  turns these into isError tool results; anything else is a crash. */
export class BoardError extends Error {}

export const LABELS = ["green", "yellow", "orange", "red", "purple", "blue"];

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}

export function defaultBoard(): Board {
  return {
    lists: [
      { id: uid("l"), title: "To do", cards: [] },
      { id: uid("l"), title: "Doing", cards: [] },
      { id: uid("l"), title: "Done", cards: [] },
    ],
  };
}

function normalizeCard(c: Partial<Card>): Card {
  const card: Card = {
    id: typeof c.id === "string" && c.id ? c.id : uid("c"),
    title: typeof c.title === "string" ? c.title : "",
    desc: typeof c.desc === "string" ? c.desc : "",
    labels: Array.isArray(c.labels) ? c.labels.filter((l): l is string => typeof l === "string") : [],
    due: typeof c.due === "string" ? c.due : null,
    checklist: Array.isArray(c.checklist)
      ? c.checklist
          .filter((i) => i && typeof i === "object" && typeof (i as ChecklistItem).text === "string")
          .map((i) => ({
            id: typeof i.id === "string" && i.id ? i.id : uid("i"),
            text: (i as ChecklistItem).text,
            done: (i as ChecklistItem).done === true,
          }))
      : [],
  };
  const d = c.done;
  if (d && typeof d === "object" && Array.isArray(d.files) && typeof d.repoRoot === "string") {
    card.done = {
      repoRoot: d.repoRoot,
      files: d.files.filter((f): f is string => typeof f === "string"),
      summary: typeof d.summary === "string" ? d.summary : undefined,
      at: typeof d.at === "number" ? d.at : 0,
    };
  }
  return card;
}

export function normalizeBoard(raw: unknown): Board {
  const r = raw as { lists?: unknown } | null;
  if (!r || !Array.isArray(r.lists)) {
    throw new BoardError('board.json has no "lists" array — expected {"version":2,"lists":[...]}');
  }
  return {
    lists: (r.lists as Partial<List>[]).map((l) => ({
      id: typeof l.id === "string" && l.id ? l.id : uid("l"),
      title: typeof l.title === "string" ? l.title : "List",
      cards: Array.isArray(l.cards) ? l.cards.map(normalizeCard) : [],
    })),
  };
}

export function boardPath(dir: string): string {
  return path.join(dir, ".maestro", "board.json");
}

export function loadBoard(dir: string): Board {
  let raw: string;
  try {
    raw = fs.readFileSync(boardPath(dir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return defaultBoard();
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BoardError(".maestro/board.json is not valid JSON — fix or delete it, then retry");
  }
  return normalizeBoard(parsed);
}

export function saveBoard(dir: string, board: Board): void {
  const p = boardPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, lists: board.lists }, null, 2), "utf8");
  fs.renameSync(tmp, p); // atomic on the same volume; replaces the target on Windows
}
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
rtk npm --prefix mcp test
```

Expected: PASS (all).

- [ ] **Step 8: Commit**

```bash
rtk git add mcp/package.json mcp/package-lock.json mcp/tsconfig.json mcp/.gitignore mcp/src/board.ts mcp/test/board.test.ts vite.config.ts
rtk git commit -m "feat(mcp): scaffold maestro-mcp package with board.json store"
```

---

### Task 2: Card operations (resolve / add / update / move / delete)

**Files:**
- Create: `mcp/src/ops.ts`
- Test: `mcp/test/ops.test.ts`

**Interfaces:**
- Consumes (Task 1): `Board`, `Card`, `List`, `BoardError`, `LABELS`, `uid`, `defaultBoard`.
- Produces (used by Tasks 3–4):
  - `resolveList(board: Board, ref: string): List`
  - `resolveOrCreateList(board: Board, ref: string): List`
  - `resolveCard(board: Board, ref: string): { list: List; idx: number; card: Card }`
  - `interface CardInput { title: string; desc?: string; labels?: string[]; due?: string | null; checklist?: string[] }`
  - `addCard(board: Board, listRef: string, input: CardInput): Card`
  - `updateCard(board: Board, cardRef: string, patch: Partial<CardInput>): Card`
  - `moveCard(board: Board, cardRef: string, toListRef: string, position?: number): Card`
  - `deleteCard(board: Board, cardRef: string): void`

All resolution: id match wins; otherwise case-insensitive trimmed title; 2+ title matches → `BoardError` telling the caller to use the id.

- [ ] **Step 1: Write the failing tests**

Create `mcp/test/ops.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defaultBoard, BoardError, type Board } from "../src/board.js";
import {
  resolveList,
  resolveOrCreateList,
  resolveCard,
  addCard,
  updateCard,
  moveCard,
  deleteCard,
} from "../src/ops.js";

const board = (): Board => defaultBoard();

describe("resolveList", () => {
  it("resolves by exact id", () => {
    const b = board();
    expect(resolveList(b, b.lists[1].id).title).toBe("Doing");
  });

  it("resolves by title, case-insensitive and trimmed", () => {
    expect(resolveList(board(), "  to DO ").title).toBe("To do");
  });

  it("errors on unknown ref", () => {
    expect(() => resolveList(board(), "nope")).toThrow(BoardError);
  });

  it("errors on ambiguous title, mentioning ids", () => {
    const b = board();
    b.lists.push({ id: "ldup", title: "To do", cards: [] });
    expect(() => resolveList(b, "to do")).toThrow(/id/i);
  });
});

describe("addCard", () => {
  it("appends with defaults and returns the card", () => {
    const b = board();
    const c = addCard(b, "To do", { title: "ship it" });
    expect(b.lists[0].cards[0]).toBe(c);
    expect(c.desc).toBe("");
    expect(c.labels).toEqual([]);
    expect(c.due).toBeNull();
  });

  it("accepts desc/labels/due/checklist", () => {
    const b = board();
    const c = addCard(b, "To do", {
      title: "t",
      desc: "d",
      labels: ["red", "blue"],
      due: "2026-07-04",
      checklist: ["a", "b"],
    });
    expect(c.labels).toEqual(["red", "blue"]);
    expect(c.due).toBe("2026-07-04");
    expect(c.checklist.map((i) => i.text)).toEqual(["a", "b"]);
    expect(c.checklist.every((i) => !i.done)).toBe(true);
  });

  it("creates the list when the title does not exist", () => {
    const b = board();
    addCard(b, "Backlog", { title: "t" });
    expect(b.lists.some((l) => l.title === "Backlog")).toBe(true);
  });

  it("rejects an empty title", () => {
    expect(() => addCard(board(), "To do", { title: "  " })).toThrow(BoardError);
  });

  it("rejects unknown labels", () => {
    expect(() => addCard(board(), "To do", { title: "t", labels: ["pink"] })).toThrow(/pink/);
  });

  it("rejects a malformed due date", () => {
    expect(() => addCard(board(), "To do", { title: "t", due: "tomorrow" })).toThrow(/yyyy-mm-dd/);
  });
});

describe("resolveCard / updateCard", () => {
  it("resolves by title across lists", () => {
    const b = board();
    addCard(b, "Doing", { title: "Fix bug" });
    expect(resolveCard(b, "fix BUG").card.title).toBe("Fix bug");
  });

  it("errors on ambiguous card title", () => {
    const b = board();
    addCard(b, "To do", { title: "dup" });
    addCard(b, "Doing", { title: "dup" });
    expect(() => resolveCard(b, "dup")).toThrow(/id/i);
  });

  it("patches only provided fields; checklist replaces as un-done items", () => {
    const b = board();
    const c = addCard(b, "To do", { title: "t", desc: "old", labels: ["red"] });
    updateCard(b, c.id, { desc: "new", checklist: ["x"] });
    expect(c.desc).toBe("new");
    expect(c.labels).toEqual(["red"]); // untouched
    expect(c.checklist.map((i) => i.text)).toEqual(["x"]);
  });

  it("validates patch labels and due", () => {
    const b = board();
    const c = addCard(b, "To do", { title: "t" });
    expect(() => updateCard(b, c.id, { labels: ["nope"] })).toThrow(BoardError);
    expect(() => updateCard(b, c.id, { due: "07/04" })).toThrow(BoardError);
  });
});

describe("moveCard", () => {
  it("moves to the end of the target list by default", () => {
    const b = board();
    const c = addCard(b, "To do", { title: "a" });
    addCard(b, "Doing", { title: "b" });
    moveCard(b, c.id, "Doing");
    expect(b.lists[0].cards).toHaveLength(0);
    expect(b.lists[1].cards.map((x) => x.title)).toEqual(["b", "a"]);
  });

  it("inserts at a 0-based position, clamped", () => {
    const b = board();
    const a = addCard(b, "Doing", { title: "a" });
    addCard(b, "Doing", { title: "b" });
    moveCard(b, a.id, "Doing", 99);
    expect(b.lists[1].cards.map((x) => x.title)).toEqual(["b", "a"]);
    moveCard(b, a.id, "Doing", 0);
    expect(b.lists[1].cards.map((x) => x.title)).toEqual(["a", "b"]);
  });
});

describe("deleteCard", () => {
  it("removes the card", () => {
    const b = board();
    const c = addCard(b, "To do", { title: "bye" });
    deleteCard(b, c.id);
    expect(b.lists[0].cards).toHaveLength(0);
  });

  it("errors when the card does not exist", () => {
    expect(() => deleteCard(board(), "ghost")).toThrow(BoardError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
rtk npm --prefix mcp test
```

Expected: FAIL — cannot resolve `../src/ops.js`.

- [ ] **Step 3: Implement `mcp/src/ops.ts`**

```ts
/* Pure board mutations for maestro-mcp. All take the Board in memory; the
 * caller (server.ts) wraps them in load → mutate → save. References resolve
 * by id first, then case-insensitive title; ambiguity is an error so agents
 * fall back to ids from board_get. */

import { type Board, type Card, type List, BoardError, LABELS, uid } from "./board.js";

const norm = (s: string) => s.trim().toLowerCase();

export function resolveList(board: Board, ref: string): List {
  const byId = board.lists.find((l) => l.id === ref);
  if (byId) return byId;
  const t = norm(ref);
  const matches = board.lists.filter((l) => norm(l.title) === t);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1)
    throw new BoardError(`Multiple lists are titled "${ref}" — use the list id from board_get`);
  throw new BoardError(`No list "${ref}" — see board_get for lists`);
}

export function resolveOrCreateList(board: Board, ref: string): List {
  try {
    return resolveList(board, ref);
  } catch (e) {
    if (e instanceof BoardError && /^No list/.test(e.message)) {
      const list: List = { id: uid("l"), title: ref.trim(), cards: [] };
      board.lists.push(list);
      return list;
    }
    throw e;
  }
}

export function resolveCard(board: Board, ref: string): { list: List; idx: number; card: Card } {
  for (const list of board.lists) {
    const idx = list.cards.findIndex((c) => c.id === ref);
    if (idx >= 0) return { list, idx, card: list.cards[idx] };
  }
  const t = norm(ref);
  const matches: { list: List; idx: number; card: Card }[] = [];
  for (const list of board.lists) {
    list.cards.forEach((card, idx) => {
      if (norm(card.title) === t) matches.push({ list, idx, card });
    });
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1)
    throw new BoardError(`Multiple cards are titled "${ref}" — use the card id from board_get`);
  throw new BoardError(`No card "${ref}" — see board_get for cards`);
}

export interface CardInput {
  title: string;
  desc?: string;
  labels?: string[];
  due?: string | null;
  checklist?: string[];
}

function validateLabels(labels: string[] | undefined): void {
  for (const l of labels ?? []) {
    if (!LABELS.includes(l))
      throw new BoardError(`Unknown label "${l}" — valid labels: ${LABELS.join("|")}`);
  }
}

function validateDue(due: string | null | undefined): void {
  if (due != null && !/^\d{4}-\d{2}-\d{2}$/.test(due))
    throw new BoardError(`due must be yyyy-mm-dd (got "${due}")`);
}

const mkChecklist = (items: string[]) =>
  items.map((text) => ({ id: uid("i"), text, done: false }));

export function addCard(board: Board, listRef: string, input: CardInput): Card {
  const title = input.title.trim();
  if (!title) throw new BoardError("title must not be empty");
  validateLabels(input.labels);
  validateDue(input.due);
  const list = resolveOrCreateList(board, listRef);
  const card: Card = {
    id: uid("c"),
    title,
    desc: input.desc ?? "",
    labels: input.labels ?? [],
    due: input.due ?? null,
    checklist: mkChecklist(input.checklist ?? []),
  };
  list.cards.push(card);
  return card;
}

export function updateCard(board: Board, cardRef: string, patch: Partial<CardInput>): Card {
  validateLabels(patch.labels);
  validateDue(patch.due);
  const { card } = resolveCard(board, cardRef);
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t) throw new BoardError("title must not be empty");
    card.title = t;
  }
  if (patch.desc !== undefined) card.desc = patch.desc;
  if (patch.labels !== undefined) card.labels = patch.labels;
  if (patch.due !== undefined) card.due = patch.due;
  if (patch.checklist !== undefined) card.checklist = mkChecklist(patch.checklist);
  return card;
}

export function moveCard(board: Board, cardRef: string, toListRef: string, position?: number): Card {
  const found = resolveCard(board, cardRef);
  const target = resolveOrCreateList(board, toListRef);
  found.list.cards.splice(found.idx, 1);
  const pos =
    position === undefined
      ? target.cards.length
      : Math.max(0, Math.min(position, target.cards.length));
  target.cards.splice(pos, 0, found.card);
  return found.card;
}

export function deleteCard(board: Board, cardRef: string): void {
  const found = resolveCard(board, cardRef);
  found.list.cards.splice(found.idx, 1);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
rtk npm --prefix mcp test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add mcp/src/ops.ts mcp/test/ops.test.ts
rtk git commit -m "feat(mcp): card operations with id-or-title resolution"
```

---

### Task 3: List operations + done evidence (git)

**Files:**
- Modify: `mcp/src/ops.ts` (append list ops + markDone)
- Create: `mcp/src/git.ts`
- Test: `mcp/test/lists.test.ts`
- Test: `mcp/test/git.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2 `resolveList`/`resolveCard`/`resolveOrCreateList`.
- Produces (used by Task 4):
  - `addList(board: Board, title: string): List`
  - `renameList(board: Board, listRef: string, title: string): List`
  - `deleteList(board: Board, listRef: string): void`
  - `markDone(board: Board, cardRef: string, evidence: { repoRoot: string; files: string[]; summary?: string }): Card` — moves to the "Done" list (created if absent), sets `card.done` with `at: Date.now()`.
  - `changedFiles(dir: string): string[]` (from `git.ts`) — `git status --porcelain` paths; `[]` when git is missing or not a repo.

- [ ] **Step 1: Write the failing tests**

Create `mcp/test/lists.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defaultBoard, BoardError } from "../src/board.js";
import { addCard, addList, renameList, deleteList, markDone, resolveCard } from "../src/ops.js";

describe("list ops", () => {
  it("addList appends", () => {
    const b = defaultBoard();
    const l = addList(b, "Backlog");
    expect(b.lists[3]).toBe(l);
    expect(l.cards).toEqual([]);
  });

  it("addList rejects empty titles", () => {
    expect(() => addList(defaultBoard(), " ")).toThrow(BoardError);
  });

  it("renameList by id or title", () => {
    const b = defaultBoard();
    renameList(b, "Doing", "In progress");
    expect(b.lists[1].title).toBe("In progress");
  });

  it("deleteList removes list and cards", () => {
    const b = defaultBoard();
    addCard(b, "To do", { title: "x" });
    deleteList(b, "To do");
    expect(b.lists.map((l) => l.title)).toEqual(["Doing", "Done"]);
  });
});

describe("markDone", () => {
  it("moves the card to Done and attaches evidence", () => {
    const b = defaultBoard();
    const c = addCard(b, "Doing", { title: "task" });
    const before = Date.now();
    markDone(b, c.id, { repoRoot: "D:\\ws", files: ["a.ts"], summary: "did it" });
    const found = resolveCard(b, c.id);
    expect(found.list.title).toBe("Done");
    expect(c.done?.files).toEqual(["a.ts"]);
    expect(c.done?.summary).toBe("did it");
    expect(c.done!.at).toBeGreaterThanOrEqual(before);
  });

  it("creates the Done list when missing", () => {
    const b = defaultBoard();
    b.lists = b.lists.filter((l) => l.title !== "Done");
    const c = addCard(b, "Doing", { title: "task" });
    markDone(b, c.id, { repoRoot: "r", files: [] });
    expect(b.lists.some((l) => l.title === "Done")).toBe(true);
  });
});
```

Create `mcp/test/git.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { changedFiles } from "../src/git.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-mcp-git-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("changedFiles", () => {
  it("returns [] outside a git repo", () => {
    expect(changedFiles(dir)).toEqual([]);
  });

  it("lists modified and untracked files in a repo", () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(dir, "tracked.txt"), "one", "utf8");
    git("add", ".");
    git("commit", "-m", "init");
    fs.writeFileSync(path.join(dir, "tracked.txt"), "two", "utf8");
    fs.writeFileSync(path.join(dir, "new.txt"), "n", "utf8");
    const files = changedFiles(dir).sort();
    expect(files).toEqual(["new.txt", "tracked.txt"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
rtk npm --prefix mcp test
```

Expected: FAIL — `addList`/`markDone` not exported; `../src/git.js` unresolved.

- [ ] **Step 3: Implement**

Append to `mcp/src/ops.ts`:

```ts
export function addList(board: Board, title: string): List {
  const t = title.trim();
  if (!t) throw new BoardError("list title must not be empty");
  const list: List = { id: uid("l"), title: t, cards: [] };
  board.lists.push(list);
  return list;
}

export function renameList(board: Board, listRef: string, title: string): List {
  const t = title.trim();
  if (!t) throw new BoardError("list title must not be empty");
  const list = resolveList(board, listRef);
  list.title = t;
  return list;
}

export function deleteList(board: Board, listRef: string): void {
  const list = resolveList(board, listRef);
  board.lists = board.lists.filter((l) => l !== list);
}

export function markDone(
  board: Board,
  cardRef: string,
  evidence: { repoRoot: string; files: string[]; summary?: string },
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
  };
  return found.card;
}
```

Create `mcp/src/git.ts`:

```ts
/* "What changed" evidence for card_done: working-tree paths from git status.
 * Best-effort — no git, not a repo, or any git failure just yields []. */

import { execFileSync } from "node:child_process";

export function changedFiles(dir: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => {
      const p = line.slice(3).trim();
      // rename lines look like "R  old -> new" — the new path is the evidence
      const arrow = p.indexOf(" -> ");
      return arrow >= 0 ? p.slice(arrow + 4) : p;
    })
    .map((p) => p.replace(/^"|"$/g, "")) // git quotes paths with special chars
    .filter(Boolean);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
rtk npm --prefix mcp test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add mcp/src/ops.ts mcp/src/git.ts mcp/test/lists.test.ts mcp/test/git.test.ts
rtk git commit -m "feat(mcp): list ops and card_done git evidence"
```

---

### Task 4: MCP server wiring + entry point

**Files:**
- Create: `mcp/src/server.ts`
- Create: `mcp/src/index.ts`
- Test: `mcp/test/server.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (`loadBoard`, `saveBoard`, `BoardError`, all ops, `changedFiles`).
- Produces: `createServer(dir: string): McpServer` and the `maestro-mcp` bin (`dist/index.js`). Nine tools: `board_get`, `card_add`, `card_update`, `card_move`, `card_delete`, `card_done`, `list_add`, `list_rename`, `list_delete`.

- [ ] **Step 1: Write the failing integration test**

Create `mcp/test/server.test.ts` (drives the real server through the SDK's in-memory transport — the same code path Claude Code uses, minus stdio):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { loadBoard } from "../src/board.js";

let dir: string;
let client: Client;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-mcp-srv-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(dir);
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const text = (res: unknown): string =>
  (res as { content: { type: string; text: string }[] }).content[0].text;

describe("maestro-mcp server", () => {
  it("lists all nine tools", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "board_get",
      "card_add",
      "card_delete",
      "card_done",
      "card_move",
      "card_update",
      "list_add",
      "list_delete",
      "list_rename",
    ]);
  });

  it("board_get returns the default board without creating the file", async () => {
    const res = await client.callTool({ name: "board_get", arguments: {} });
    const board = JSON.parse(text(res));
    expect(board.lists.map((l: { title: string }) => l.title)).toEqual(["To do", "Doing", "Done"]);
    expect(fs.existsSync(path.join(dir, ".maestro", "board.json"))).toBe(false);
  });

  it("card_add persists to board.json", async () => {
    await client.callTool({
      name: "card_add",
      arguments: { list: "To do", title: "from agent", labels: ["blue"] },
    });
    const board = loadBoard(dir);
    expect(board.lists[0].cards[0].title).toBe("from agent");
  });

  it("card_move + card_update round-trip", async () => {
    await client.callTool({ name: "card_add", arguments: { list: "To do", title: "t" } });
    await client.callTool({ name: "card_move", arguments: { card: "t", to_list: "Doing" } });
    await client.callTool({ name: "card_update", arguments: { card: "t", desc: "moving along" } });
    const board = loadBoard(dir);
    const doing = board.lists.find((l) => l.title === "Doing")!;
    expect(doing.cards[0].desc).toBe("moving along");
  });

  it("card_done moves to Done with evidence fields", async () => {
    await client.callTool({ name: "card_add", arguments: { list: "Doing", title: "t" } });
    await client.callTool({ name: "card_done", arguments: { card: "t", summary: "shipped" } });
    const board = loadBoard(dir);
    const done = board.lists.find((l) => l.title === "Done")!;
    expect(done.cards[0].done?.summary).toBe("shipped");
    expect(done.cards[0].done?.repoRoot).toBe(dir);
    expect(Array.isArray(done.cards[0].done?.files)).toBe(true);
  });

  it("list ops work end to end", async () => {
    await client.callTool({ name: "list_add", arguments: { title: "Backlog" } });
    await client.callTool({ name: "list_rename", arguments: { list: "Backlog", title: "Icebox" } });
    await client.callTool({ name: "list_delete", arguments: { list: "Icebox" } });
    const board = loadBoard(dir);
    expect(board.lists.map((l) => l.title)).toEqual(["To do", "Doing", "Done"]);
  });

  it("BoardError becomes an isError result, not a crash", async () => {
    const res = (await client.callTool({
      name: "card_delete",
      arguments: { card: "ghost" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });

  it("a corrupt board.json errors and is never overwritten", async () => {
    fs.mkdirSync(path.join(dir, ".maestro"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".maestro", "board.json"), "{broken", "utf8");
    const res = (await client.callTool({
      name: "card_add",
      arguments: { list: "To do", title: "x" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".maestro", "board.json"), "utf8")).toBe("{broken");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
rtk npm --prefix mcp test
```

Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 3: Implement `mcp/src/server.ts`**

```ts
/* MCP surface: nine tools over the board store. Each mutating tool is one
 * load → mutate → save cycle (nothing cached between calls, so a long agent
 * session always sees the Maestro UI's edits). BoardError → isError result. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadBoard, saveBoard, BoardError, LABELS, type Board } from "./board.js";
import {
  addCard,
  updateCard,
  moveCard,
  deleteCard,
  markDone,
  addList,
  renameList,
  deleteList,
} from "./ops.js";
import { changedFiles } from "./git.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

const labelsSchema = z
  .array(z.string())
  .optional()
  .describe(`Label colour keys: ${LABELS.join("|")}`);

export function createServer(dir: string): McpServer {
  const server = new McpServer({ name: "maestro", version: "0.1.0" });

  /** load → mutate → save, mapping BoardError to an isError tool result. */
  const mutate = (fn: (b: Board) => unknown): ToolResult => {
    try {
      const board = loadBoard(dir);
      const result = fn(board);
      saveBoard(dir, board);
      return ok(result ?? "ok");
    } catch (e) {
      return fail(e);
    }
  };

  server.registerTool(
    "board_get",
    {
      description:
        "Read the Maestro kanban board for this workspace (.maestro/board.json): all lists and their cards, including ids to use with the other tools.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(loadBoard(dir));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "card_add",
    {
      description:
        "Add a card to a list on the Maestro board. `list` is a list id or title (created if the title doesn't exist).",
      inputSchema: {
        list: z.string().describe("List id or title"),
        title: z.string().describe("Card title"),
        desc: z.string().optional().describe("Longer description"),
        labels: labelsSchema,
        due: z.string().optional().describe("Due date, yyyy-mm-dd"),
        checklist: z.array(z.string()).optional().describe("Checklist item texts"),
      },
    },
    async ({ list, title, desc, labels, due, checklist }) =>
      mutate((b) => addCard(b, list, { title, desc, labels, due, checklist })),
  );

  server.registerTool(
    "card_update",
    {
      description:
        "Update fields of a card. `card` is a card id or exact title. Only provided fields change; `checklist` replaces the whole checklist with un-done items.",
      inputSchema: {
        card: z.string().describe("Card id or title"),
        title: z.string().optional(),
        desc: z.string().optional(),
        labels: labelsSchema,
        due: z.string().nullable().optional().describe("yyyy-mm-dd, or null to clear"),
        checklist: z.array(z.string()).optional(),
      },
    },
    async ({ card, ...patch }) => mutate((b) => updateCard(b, card, patch)),
  );

  server.registerTool(
    "card_move",
    {
      description:
        "Move a card to another list (e.g. To do → Doing). `position` is 0-based; omitted = end of the list.",
      inputSchema: {
        card: z.string().describe("Card id or title"),
        to_list: z.string().describe("Target list id or title"),
        position: z.number().int().min(0).optional(),
      },
    },
    async ({ card, to_list, position }) => mutate((b) => moveCard(b, card, to_list, position)),
  );

  server.registerTool(
    "card_delete",
    {
      description: "Delete a card from the board.",
      inputSchema: { card: z.string().describe("Card id or title") },
    },
    async ({ card }) =>
      mutate((b) => {
        deleteCard(b, card);
        return "deleted";
      }),
  );

  server.registerTool(
    "card_done",
    {
      description:
        "Mark a task finished: move the card to the Done list and attach evidence (summary + files currently changed in git).",
      inputSchema: {
        card: z.string().describe("Card id or title"),
        summary: z.string().optional().describe("One line on what changed"),
      },
    },
    async ({ card, summary }) =>
      mutate((b) => markDone(b, card, { repoRoot: dir, files: changedFiles(dir), summary })),
  );

  server.registerTool(
    "list_add",
    {
      description: "Add a new empty list to the board.",
      inputSchema: { title: z.string() },
    },
    async ({ title }) => mutate((b) => addList(b, title)),
  );

  server.registerTool(
    "list_rename",
    {
      description: "Rename a list.",
      inputSchema: {
        list: z.string().describe("List id or current title"),
        title: z.string().describe("New title"),
      },
    },
    async ({ list, title }) => mutate((b) => renameList(b, list, title)),
  );

  server.registerTool(
    "list_delete",
    {
      description: "Delete a list and all its cards.",
      inputSchema: { list: z.string().describe("List id or title") },
    },
    async ({ list }) =>
      mutate((b) => {
        deleteList(b, list);
        return "deleted";
      }),
  );

  return server;
}
```

- [ ] **Step 4: Implement `mcp/src/index.ts`**

```ts
#!/usr/bin/env node
/* maestro-mcp entry: stdio MCP server for the Maestro kanban board.
 * Workspace = argv[2] if given, else cwd (Claude Code spawns stdio servers
 * with cwd = the project root, so a user-scoped install needs no args). */

import fs from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const dir = path.resolve(process.argv[2] ?? process.cwd());
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`maestro-mcp: workspace directory not found: ${dir}`);
  process.exit(1);
}

const server = createServer(dir);
await server.connect(new StdioServerTransport());
```

- [ ] **Step 5: Run tests, then build**

```bash
rtk npm --prefix mcp test
rtk npm --prefix mcp run build
```

Expected: tests PASS; `mcp/dist/index.js` exists and starts with the shebang.

- [ ] **Step 6: Smoke the real stdio binary**

```bash
rtk node mcp/dist/index.js --help < NUL
```

(Windows note: piping `< NUL` from PowerShell doesn't work — instead run:
`echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | rtk node mcp/dist/index.js`)
Expected: a single JSON-RPC response line naming the server `maestro` — proves the built bin boots.

- [ ] **Step 7: Commit**

```bash
rtk git add mcp/src/server.ts mcp/src/index.ts mcp/test/server.test.ts
rtk git commit -m "feat(mcp): stdio MCP server with nine board tools"
```

---

### Task 5: App — extract the shared board model to `src/board.ts`

Pure refactor: kanban.ts's board model moves to a module the file-persistence code (Task 6) can also import. Behaviour unchanged; existing tests must stay green.

**Files:**
- Create: `src/board.ts`
- Modify: `src/kanban.ts` (delete the moved definitions, import them instead)
- Test: `src/board.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 6–7 and re-exported for existing tests):
  - Types `ChecklistItem`, `DoneInfo`, `Card`, `List`, `Board` (exact shapes currently in `src/kanban.ts:62-90`)
  - `LABELS` (same array as `src/kanban.ts:93-100`), `labelHex(k: string): string`
  - `uid(prefix: string): string`, `mkCard(title: string): Card`, `defaultBoard(): Board`
  - `normalizeCard(c: Partial<Card>): Card`
  - `normalizeLists(raw: unknown): Board | null` — the `{lists:[...]}` branch of today's `normalize()`; returns null when the shape doesn't match (caller handles legacy/default)
  - `findCardIn(board: Board, id: string): { list: List; idx: number; card: Card } | null`
  - `applyDomOrder(board: Board, order: { id: string; cardIds: string[] }[]): void` — rebuilds list/card order from a DOM snapshot, keeping externally-added lists and re-homing cards the snapshot doesn't know (see code below)

- [ ] **Step 1: Write the failing tests**

Create `src/board.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  defaultBoard,
  normalizeLists,
  findCardIn,
  applyDomOrder,
  mkCard,
  type Board,
} from "./board";

describe("normalizeLists", () => {
  it("returns null for non-board shapes", () => {
    expect(normalizeLists(null)).toBeNull();
    expect(normalizeLists({ todo: [] })).toBeNull();
  });

  it("normalizes sparse cards", () => {
    const b = normalizeLists({ lists: [{ id: "l1", title: "T", cards: [{ id: "c1", title: "x" }] }] })!;
    expect(b.lists[0].cards[0]).toMatchObject({ desc: "", labels: [], due: null, checklist: [] });
  });
});

describe("findCardIn", () => {
  it("finds a card across lists", () => {
    const b = defaultBoard();
    const c = mkCard("hello");
    b.lists[1].cards.push(c);
    expect(findCardIn(b, c.id)?.list.title).toBe("Doing");
    expect(findCardIn(b, "nope")).toBeNull();
  });
});

describe("applyDomOrder", () => {
  const boardWith = (): { b: Board; ids: Record<string, string> } => {
    const b = defaultBoard();
    const a = mkCard("a");
    const c = mkCard("c");
    b.lists[0].cards.push(a, c);
    return { b, ids: { a: a.id, c: c.id, todo: b.lists[0].id, doing: b.lists[1].id, done: b.lists[2].id } };
  };

  it("applies list and card order from the snapshot", () => {
    const { b, ids } = boardWith();
    applyDomOrder(b, [
      { id: ids.doing, cardIds: [ids.c] },
      { id: ids.todo, cardIds: [ids.a] },
      { id: ids.done, cardIds: [] },
    ]);
    expect(b.lists.map((l) => l.title)).toEqual(["Doing", "To do", "Done"]);
    expect(b.lists[0].cards.map((x) => x.title)).toEqual(["c"]);
  });

  it("keeps a card the snapshot doesn't know, at its home list's end", () => {
    const { b, ids } = boardWith();
    const ghost = mkCard("agent-added");
    b.lists[0].cards.push(ghost); // added externally after the drag started
    applyDomOrder(b, [
      { id: ids.todo, cardIds: [ids.c, ids.a] },
      { id: ids.doing, cardIds: [] },
      { id: ids.done, cardIds: [] },
    ]);
    expect(b.lists[0].cards.map((x) => x.title)).toEqual(["c", "a", "agent-added"]);
  });

  it("keeps a list the snapshot doesn't know", () => {
    const { b, ids } = boardWith();
    b.lists.push({ id: "lnew", title: "Agent list", cards: [] });
    applyDomOrder(b, [
      { id: ids.todo, cardIds: [ids.a, ids.c] },
      { id: ids.doing, cardIds: [] },
      { id: ids.done, cardIds: [] },
    ]);
    expect(b.lists.map((l) => l.title)).toEqual(["To do", "Doing", "Done", "Agent list"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
rtk npm test
```

Expected: FAIL — `src/board.ts` doesn't exist.

- [ ] **Step 3: Create `src/board.ts`**

Move these from `src/kanban.ts` verbatim (delete them there): the `ChecklistItem`, `DoneInfo`, `Card`, `List`, `Board` interfaces (`src/kanban.ts:62-90`), `LABELS` + `labelHex` (`:93-101`), `idSeq`/`uid` (`:106-110`), `defaultBoard` (`:122-130`), `normalizeCard` (`:160-179`), `mkCard` (`:180-182`). Then add `normalizeLists`, `findCardIn`, `applyDomOrder`:

```ts
/* Shared kanban board model: types, defaults, normalization, and pure
 * order/lookup helpers. Used by the board UI (kanban.ts) and the board.json
 * file persistence (boardfile.ts). Keep this module DOM-free and IPC-free so
 * it stays unit-testable. */

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}
/** Evidence attached when a task is finished: which files changed + a summary. */
export interface DoneInfo {
  repoRoot: string;
  files: string[]; // paths relative to repoRoot
  summary?: string; // optional agent-written note
  at: number; // ms timestamp
}
export interface Card {
  id: string;
  title: string;
  desc: string;
  labels: string[]; // label colour keys
  due: string | null; // ISO date (yyyy-mm-dd) or null
  checklist: ChecklistItem[];
  done?: DoneInfo; // present once the task is marked Done (code evidence)
}
export interface List {
  id: string;
  title: string;
  cards: Card[];
}
export interface Board {
  lists: List[];
}

/* Trello-flavoured label palette, tuned to the app's dark surfaces. */
export const LABELS: { key: string; hex: string; name: string }[] = [
  { key: "green", hex: "#3ad29f", name: "Green" },
  { key: "yellow", hex: "#e6c84a", name: "Yellow" },
  { key: "orange", hex: "#e0913a", name: "Orange" },
  { key: "red", hex: "#ff6b6b", name: "Red" },
  { key: "purple", hex: "#b18cf0", name: "Purple" },
  { key: "blue", hex: "#5ec2f0", name: "Blue" },
];
export const labelHex = (k: string) => LABELS.find((l) => l.key === k)?.hex ?? "#7d8b99";

let idSeq = 0;
export function uid(p: string): string {
  idSeq += 1;
  return `${p}${Date.now().toString(36)}${idSeq}`;
}

export function mkCard(title: string): Card {
  return { id: uid("c"), title, desc: "", labels: [], due: null, checklist: [] };
}

export function defaultBoard(): Board {
  return {
    lists: [
      { id: uid("l"), title: "To do", cards: [] },
      { id: uid("l"), title: "Doing", cards: [] },
      { id: uid("l"), title: "Done", cards: [] },
    ],
  };
}

export function normalizeCard(c: Partial<Card>): Card {
  const card: Card = {
    id: c.id || uid("c"),
    title: typeof c.title === "string" ? c.title : "",
    desc: typeof c.desc === "string" ? c.desc : "",
    labels: Array.isArray(c.labels) ? c.labels : [],
    due: typeof c.due === "string" ? c.due : null,
    checklist: Array.isArray(c.checklist) ? c.checklist : [],
  };
  const d = c.done;
  if (d && typeof d === "object" && Array.isArray(d.files) && typeof d.repoRoot === "string") {
    card.done = {
      repoRoot: d.repoRoot,
      files: d.files.filter((f): f is string => typeof f === "string"),
      summary: typeof d.summary === "string" ? d.summary : undefined,
      at: typeof d.at === "number" ? d.at : 0,
    };
  }
  return card;
}

/** Normalize a raw `{lists:[...]}` value to a Board, or null when the shape
 *  doesn't match (caller falls back to legacy storage or the default board). */
export function normalizeLists(raw: unknown): Board | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || !Array.isArray((r as { lists?: unknown }).lists)) return null;
  const lists = (r.lists as List[]).map((l) => ({
    id: l.id || uid("l"),
    title: typeof l.title === "string" ? l.title : "List",
    cards: Array.isArray(l.cards) ? l.cards.map(normalizeCard) : [],
  }));
  return { lists };
}

export function findCardIn(board: Board, id: string): { list: List; idx: number; card: Card } | null {
  for (const list of board.lists) {
    const idx = list.cards.findIndex((c) => c.id === id);
    if (idx >= 0) return { list, idx, card: list.cards[idx] };
  }
  return null;
}

/** Rebuild list/card order from a DOM snapshot (a drag just ended). The
 *  snapshot may be stale against `board` — an agent can write board.json
 *  mid-drag — so anything the snapshot doesn't know is kept: unknown lists
 *  stay (appended after the known order), unknown cards return to the end of
 *  the list they were in. */
export function applyDomOrder(board: Board, order: { id: string; cardIds: string[] }[]): void {
  const listById = new Map(board.lists.map((l) => [l.id, l]));
  const cardById = new Map<string, Card>();
  const homeList = new Map<string, string>();
  for (const l of board.lists)
    for (const c of l.cards) {
      cardById.set(c.id, c);
      homeList.set(c.id, l.id);
    }
  const placed = new Set<string>();
  const nextLists: List[] = [];
  for (const o of order) {
    const list = listById.get(o.id);
    if (!list) continue; // list deleted externally while dragging
    list.cards = o.cardIds
      .map((id) => cardById.get(id))
      .filter((c): c is Card => !!c);
    for (const c of list.cards) placed.add(c.id);
    nextLists.push(list);
    listById.delete(o.id);
  }
  for (const l of listById.values()) nextLists.push(l); // lists the DOM didn't know
  if (nextLists.length) board.lists = nextLists;
  for (const [id, c] of cardById) {
    if (placed.has(id)) continue;
    const home = board.lists.find((l) => l.id === homeList.get(id)) ?? board.lists[0];
    if (home && !home.cards.includes(c)) home.cards.push(c);
  }
}
```

- [ ] **Step 4: Rewire `src/kanban.ts`**

- Delete the moved definitions from kanban.ts.
- At the top add:

```ts
import {
  LABELS,
  labelHex,
  uid,
  mkCard,
  defaultBoard,
  normalizeLists,
  findCardIn,
  type Board,
  type Card,
  type List,
} from "./board";

export type { Board, Card } from "./board"; // kanban.test.ts + panels import from here
```

- `normalize(raw, ctxKey)` in kanban.ts becomes a thin wrapper:

```ts
/** Bring any stored shape up to the current Board model — including the v1
 *  {todo,doing,done} format so existing boards survive the upgrade. */
function normalize(raw: unknown, ctxKey: string): Board {
  const asLists = normalizeLists(raw);
  if (asLists) return asLists;
  // legacy v1: { todo:[{id,text}], doing:[...], done:[...] }
  const legacy = loadJSON<Record<string, { id: string; text: string }[]>>(
    legacyKeyFor(ctxKey),
    {},
  );
  if (legacy && (legacy.todo || legacy.doing || legacy.done)) {
    const mk = (title: string, arr?: { id: string; text: string }[]): List => ({
      id: uid("l"),
      title,
      cards: (arr ?? []).map((c) => mkCard(c.text)),
    });
    return { lists: [mk("To do", legacy.todo), mk("Doing", legacy.doing), mk("Done", legacy.done)] };
  }
  return defaultBoard();
}
```

- The local `findCard(id)` helper stays but delegates: `const findCard = (id: string) => findCardIn(board, id);`

- [ ] **Step 5: Typecheck and run all tests**

```bash
rtk npx tsc --noEmit
rtk npm test
```

Expected: clean typecheck; all existing tests + new board tests PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add src/board.ts src/board.test.ts src/kanban.ts
rtk git commit -m "refactor: extract shared kanban board model to src/board.ts"
```

---

### Task 6: App — `src/boardfile.ts` file persistence helpers

**Files:**
- Create: `src/boardfile.ts`
- Test: `src/boardfile.test.ts`

**Interfaces:**
- Consumes: `fsReadFile`, `fsStat`, `fsWriteFile`, `fsCreateFile`, `fsCreateDir` from `src/ipc.ts`; `normalizeLists`, `Board` from `src/board.ts`.
- Produces (used by Task 7):
  - `const BOARD_JSON_REL = ".maestro\\board.json"`
  - `class BoardFileCorrupt extends Error`
  - `interface BoardFile { board: Board; mtime: number }`
  - `serializeBoard(board: Board): string`
  - `statBoardFile(dir: string): Promise<number | null>` — mtime, or null when missing
  - `readBoardFile(dir: string): Promise<BoardFile | null>` — null when missing; throws `BoardFileCorrupt` on bad JSON/shape
  - `writeBoardFile(dir: string, board: Board, expectedMtime: number | null): Promise<number>` — creates `.maestro/` + file if needed; passes `expectedMtime` to `fsWriteFile` (its Conflict rejection propagates); returns new mtime

- [ ] **Step 1: Write the failing tests**

Create `src/boardfile.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultBoard } from "./board";

// In-memory fake of the Tauri fs IPC: root+path → { content, mtime }.
const files = new Map<string, { content: string; mtime: number }>();
let clock = 100;
const key = (root: string, path: string) => `${root}|${path}`;

vi.mock("./ipc", () => ({
  fsReadFile: vi.fn(async (root: string, path: string) => {
    const f = files.get(key(root, path));
    if (!f) throw new Error("NotFound");
    return f;
  }),
  fsStat: vi.fn(async (root: string, path: string) => {
    const f = files.get(key(root, path));
    if (!f) throw new Error("NotFound");
    return { mtime: f.mtime };
  }),
  fsWriteFile: vi.fn(async (root: string, path: string, content: string, expectedMtime: number | null) => {
    const f = files.get(key(root, path));
    if (expectedMtime !== null && f && f.mtime !== expectedMtime) throw new Error("Conflict");
    clock += 1;
    files.set(key(root, path), { content, mtime: clock });
    return { mtime: clock };
  }),
  fsCreateFile: vi.fn(async (root: string, path: string) => {
    if (files.has(key(root, path))) throw new Error("Exists");
    clock += 1;
    files.set(key(root, path), { content: "", mtime: clock });
  }),
  fsCreateDir: vi.fn(async () => {}),
}));

import {
  BOARD_JSON_REL,
  BoardFileCorrupt,
  readBoardFile,
  writeBoardFile,
  statBoardFile,
  serializeBoard,
} from "./boardfile";

beforeEach(() => {
  files.clear();
});

describe("boardfile", () => {
  it("statBoardFile returns null when missing", async () => {
    expect(await statBoardFile("D:\\ws")).toBeNull();
  });

  it("readBoardFile returns null when missing", async () => {
    expect(await readBoardFile("D:\\ws")).toBeNull();
  });

  it("write → stat → read round-trips", async () => {
    const b = defaultBoard();
    const mtime = await writeBoardFile("D:\\ws", b, null);
    expect(await statBoardFile("D:\\ws")).toBe(mtime);
    const bf = await readBoardFile("D:\\ws");
    expect(bf?.mtime).toBe(mtime);
    expect(bf?.board.lists.map((l) => l.title)).toEqual(["To do", "Doing", "Done"]);
  });

  it("serializes with the version wrapper", () => {
    const raw = JSON.parse(serializeBoard(defaultBoard()));
    expect(raw.version).toBe(2);
  });

  it("throws BoardFileCorrupt on invalid JSON", async () => {
    files.set(`D:\\ws|${BOARD_JSON_REL}`, { content: "{oops", mtime: 1 });
    await expect(readBoardFile("D:\\ws")).rejects.toBeInstanceOf(BoardFileCorrupt);
  });

  it("throws BoardFileCorrupt when lists is missing", async () => {
    files.set(`D:\\ws|${BOARD_JSON_REL}`, { content: "{}", mtime: 1 });
    await expect(readBoardFile("D:\\ws")).rejects.toBeInstanceOf(BoardFileCorrupt);
  });

  it("propagates a Conflict from a stale expectedMtime", async () => {
    const b = defaultBoard();
    const m1 = await writeBoardFile("D:\\ws", b, null);
    await writeBoardFile("D:\\ws", b, m1); // bumps mtime
    await expect(writeBoardFile("D:\\ws", b, m1)).rejects.toThrow("Conflict");
  });

  it("second write does not re-create the file", async () => {
    const b = defaultBoard();
    const m1 = await writeBoardFile("D:\\ws", b, null);
    const m2 = await writeBoardFile("D:\\ws", b, m1);
    expect(m2).toBeGreaterThan(m1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
rtk npm test
```

Expected: FAIL — `src/boardfile.ts` doesn't exist.

- [ ] **Step 3: Implement `src/boardfile.ts`**

```ts
/* board.json persistence for the kanban board — the same file maestro-mcp
 * (the agent-facing MCP server) reads and writes. The UI re-reads before every
 * mutation and passes the last-seen mtime to fs_write_file so a concurrent
 * agent write surfaces as a Conflict instead of being clobbered. */

import { fsCreateDir, fsCreateFile, fsReadFile, fsStat, fsWriteFile } from "./ipc";
import { normalizeLists, type Board } from "./board";

export const BOARD_JSON_REL = ".maestro\\board.json";
const MAESTRO_DIR = ".maestro";

export class BoardFileCorrupt extends Error {}

export interface BoardFile {
  board: Board;
  mtime: number;
}

export function serializeBoard(board: Board): string {
  return JSON.stringify({ version: 2, lists: board.lists }, null, 2);
}

/** mtime of board.json, or null when the file doesn't exist yet. */
export async function statBoardFile(dir: string): Promise<number | null> {
  try {
    return (await fsStat(dir, BOARD_JSON_REL)).mtime;
  } catch {
    return null;
  }
}

/** Read + parse board.json. null when missing; BoardFileCorrupt on bad
 *  JSON/shape (the caller must NOT write over a corrupt file). */
export async function readBoardFile(dir: string): Promise<BoardFile | null> {
  let content: string;
  let mtime: number;
  try {
    ({ content, mtime } = await fsReadFile(dir, BOARD_JSON_REL));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new BoardFileCorrupt("board.json is not valid JSON");
  }
  const board = normalizeLists(parsed);
  if (!board) throw new BoardFileCorrupt("board.json has no lists array");
  return { board, mtime };
}

/** Write board.json (creating .maestro/ and the file on first use). Rejects
 *  with the backend's Conflict error when expectedMtime is stale. */
export async function writeBoardFile(
  dir: string,
  board: Board,
  expectedMtime: number | null,
): Promise<number> {
  try {
    await fsCreateDir(dir, MAESTRO_DIR);
  } catch {
    /* already exists */
  }
  try {
    await fsCreateFile(dir, BOARD_JSON_REL);
  } catch {
    /* already exists */
  }
  return (await fsWriteFile(dir, BOARD_JSON_REL, serializeBoard(board), expectedMtime)).mtime;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
rtk npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/boardfile.ts src/boardfile.test.ts
rtk git commit -m "feat: board.json read/write helpers for the kanban board"
```

---

### Task 7: App — kanban.ts reads/writes board.json

Wire the UI to the file: load on context switch (with one-time localStorage migration), route every mutation through a read-modify-write helper, and reload on external mtime changes in the existing 3.5s watch loop. Dir-less quick terminals keep localStorage.

**Files:**
- Modify: `src/kanban.ts`

**Interfaces:**
- Consumes: Task 5 (`findCardIn`, `applyDomOrder`, `defaultBoard`, …), Task 6 (`readBoardFile`, `writeBoardFile`, `statBoardFile`, `BoardFile`).
- Produces: no new exports — behaviour change only. `cardToAgentText`/`boardToMarkdown` and the `Card`/`Board` re-exports are unchanged.

- [ ] **Step 1: Add state + the withBoard helper**

In `createKanban()`, next to the existing `dir`/`planMtime` state (`src/kanban.ts:236-243`), add:

```ts
let boardMtime: number | null = null; // last-seen board.json mtime (null = no file yet)
```

Add imports at the top of kanban.ts:

```ts
import { readBoardFile, writeBoardFile, statBoardFile, type BoardFile } from "./boardfile";
import { applyDomOrder } from "./board";
```

Add the mutation helper (replaces the old `persist()` for model changes — `scheduleBoardFile()` stays as the board.md mirror):

```ts
/** Apply a model change. With a workspace dir the file is the source of
 *  truth: re-read board.json, mutate the fresh copy, write it back guarded by
 *  the mtime we read (an agent write in between = Conflict → retry once on
 *  the newer copy). Dir-less contexts keep the old localStorage behaviour. */
async function withBoard(mutator: (b: Board) => void): Promise<void> {
  if (!ctx) return;
  if (!dir) {
    mutator(board);
    saveJSON(keyFor(ctx.key), board);
    scheduleBoardFile();
    rerender();
    return;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let bf: BoardFile | null = null;
    try {
      bf = await readBoardFile(dir);
    } catch {
      // corrupt file: mutate the in-memory copy; the forced write below
      // replaces the corrupt file — this is the user's explicit action.
    }
    const fresh = bf ? bf.board : board;
    mutator(fresh);
    try {
      boardMtime = await writeBoardFile(dir, fresh, bf ? bf.mtime : null);
      board = fresh;
      scheduleBoardFile();
      rerender();
      return;
    } catch {
      /* Conflict — an agent wrote between our read and write; retry on its copy */
    }
  }
}

/** Re-render whichever view is open (board or card detail). */
function rerender(): void {
  if (openCardId && findCard(openCardId)) renderDetail();
  else {
    openCardId = openCardId && findCard(openCardId) ? openCardId : null;
    render();
  }
}
```

- [ ] **Step 2: Convert every mutator to withBoard**

Replace the bodies of the mutation functions (`src/kanban.ts:694-737` plus the plan-bridge writers). Each one now looks up by id inside the mutator so it works on the fresh copy:

```ts
function addList(title: string) {
  const t = title.trim();
  if (!t) return;
  void withBoard((b) => {
    b.lists.push({ id: uid("l"), title: t, cards: [] });
  });
}
function renameList(id: string, title: string) {
  const t = title.trim();
  void withBoard((b) => {
    const list = b.lists.find((l) => l.id === id);
    if (list && t) list.title = t;
  });
}
function deleteList(id: string) {
  void withBoard((b) => {
    b.lists = b.lists.filter((l) => l.id !== id);
  });
}
function addCard(listId: string, title: string) {
  const t = title.trim();
  if (!t) return;
  void withBoard((b) => {
    b.lists.find((l) => l.id === listId)?.cards.push(mkCard(t));
  });
}
function patchCard(id: string, patch: Partial<Card>) {
  void withBoard((b) => {
    const found = findCardIn(b, id);
    if (found) Object.assign(found.card, patch);
  });
}
function deleteCard(id: string) {
  openCardId = null;
  void withBoard((b) => {
    const found = findCardIn(b, id);
    if (found) found.list.cards.splice(found.idx, 1);
  });
}
```

`commitFromDom()` (`src/kanban.ts:652-674`) becomes a DOM snapshot + `applyDomOrder`:

```ts
/** Rebuild board (list order + each list's cards) from the current DOM order.
 *  Called on dragend so a live-reordered DOM becomes the source of truth —
 *  applied onto the freshest board.json copy (see applyDomOrder for how
 *  mid-drag agent edits are kept). */
function commitFromDom() {
  if (!root) return;
  const order: { id: string; cardIds: string[] }[] = [];
  root.querySelectorAll<HTMLElement>(".kb-list").forEach((listNode) => {
    if (!listNode.dataset.list) return;
    const cardIds: string[] = [];
    listNode.querySelectorAll<HTMLElement>(".kb-card").forEach((cardNode) => {
      if (cardNode.dataset.card) cardIds.push(cardNode.dataset.card);
    });
    order.push({ id: listNode.dataset.list, cardIds });
  });
  void withBoard((b) => applyDomOrder(b, order));
}
```

`attachDoneEvidence` (`src/kanban.ts:363-376`) re-targets the card by id:

```ts
async function attachDoneEvidence(card: Card, summary?: string): Promise<void> {
  const repoRoot = (await resolveRepoRoot()) ?? dir ?? "";
  let files: string[] = [];
  if (repoRoot) {
    try {
      files = (await gitChangedFiles(repoRoot)).map((f) => f.path);
    } catch {
      /* not a repo */
    }
  }
  await withBoard((b) => {
    const found = findCardIn(b, card.id);
    if (found) found.card.done = { repoRoot, files, summary, at: Date.now() };
  });
}
```

`importProposed` (`:267-286`) and `importDone` (`:399-436`) move their board writes inside a single withBoard call each (the `seen`/`doneSeen` bookkeeping stays outside):

```ts
async function importProposed(tasks: PlanTask[]): Promise<number> {
  let added = 0;
  const fresh = tasks.filter((t) => {
    const key = t.title.toLowerCase();
    return !seen.has(key) && !boardHasTitle(t.title);
  });
  if (!fresh.length) return 0;
  await withBoard((b) => {
    const list = findOrCreateListIn(b, PROPOSED_TITLE);
    for (const t of fresh) {
      const card = mkCard(t.title);
      if (t.desc) card.desc = t.desc;
      card.labels = [t.label ?? "blue"];
      list.cards.push(card);
      seen.add(t.title.toLowerCase());
      added += 1;
    }
  });
  saveSeen();
  return added;
}
```

`findOrCreateList`/`findCardByTitle` become board-parameterised local helpers (same logic, first arg `b: Board`, renamed `findOrCreateListIn`/`findCardByTitleIn`); `boardHasTitle` keeps reading the module-level `board` (pre-filter only — the authoritative dedup is `seen`). `importDone` follows the same pattern: collect new entries, then one `withBoard` that moves/creates each card in the Done list, followed by `attachDoneEvidence` per card.

Remove the old `persist()` function entirely; `maybeFireDone` and rename/checklist paths flow through the converted mutators.

- [ ] **Step 3: Load from file in setContext (+ migration)**

Replace the `setContext` body (`src/kanban.ts:1111-1124`):

```ts
setContext(next: DockContext | null) {
  ctx = next;
  openCardId = null;
  dir = next?.dir ?? null;
  planMtime = 0;
  doneMtime = 0;
  boardMtime = null;
  seen = next ? loadSeen(next.key) : new Set();
  doneSeen = next ? new Set(loadJSON<string[]>(doneSeenKey(next.key), [])) : new Set();
  board = defaultBoard();
  render();
  if (!ctx) return;
  void (async () => {
    await loadBoardForContext();
    render();
    void importFromFile(); // pull any existing plan for this folder
    void importDone(); // and any already-reported done tasks
    scheduleBoardFile(); // mirror the current board so the agent can read it
  })();
},
```

Add the loader next to withBoard:

```ts
/** Load the context's board: board.json when the workspace has a dir
 *  (migrating the old localStorage board into the file on first run),
 *  localStorage otherwise. Corrupt file → in-memory default; the file is
 *  only replaced when the user makes a mutation (withBoard's forced write). */
async function loadBoardForContext(): Promise<void> {
  if (!ctx) return;
  if (!dir) {
    board = normalize(loadJSON<unknown>(keyFor(ctx.key), null), ctx.key);
    return;
  }
  try {
    const bf = await readBoardFile(dir);
    if (bf) {
      board = bf.board;
      boardMtime = bf.mtime;
      return;
    }
  } catch {
    console.warn(
      "maestro: .maestro/board.json is corrupt — showing an in-memory board; fix or delete the file",
    );
    board = defaultBoard();
    return;
  }
  // No file yet: seed it from the localStorage board (one-time migration; the
  // localStorage copy stays behind as a backup but is no longer read).
  board = normalize(loadJSON<unknown>(keyFor(ctx.key), null), ctx.key);
  try {
    boardMtime = await writeBoardFile(dir, board, null);
  } catch {
    /* folder unwritable — board stays in-memory for this session */
  }
}
```

- [ ] **Step 4: Reload on external changes in the watch loop**

Add next to `pollPlan`/`pollDone`:

```ts
/** Background poll: when maestro-mcp (an agent) rewrites board.json, reload.
 *  Skipped mid-drag and while an input inside the board is focused, so the
 *  DOM isn't yanked out from under the user; the next tick catches up. */
async function pollBoardJson(): Promise<void> {
  if (!dir || drag) return;
  const active = document.activeElement;
  if (
    root &&
    active &&
    root.contains(active) &&
    (active.tagName === "TEXTAREA" || active.tagName === "INPUT")
  )
    return;
  const mtime = await statBoardFile(dir);
  if (mtime === null || mtime === boardMtime) return;
  try {
    const bf = await readBoardFile(dir);
    if (!bf) return;
    board = bf.board;
    boardMtime = bf.mtime;
    rerender();
    scheduleBoardFile(); // keep the board.md mirror in step
  } catch {
    /* corrupt right now (or mid-write) — retry next tick */
  }
}
```

Extend the interval in `mount()` (`src/kanban.ts:1104-1108`):

```ts
if (watchTimer === null)
  watchTimer = window.setInterval(() => {
    void pollPlan();
    void pollDone();
    void pollBoardJson();
  }, 3500);
```

- [ ] **Step 5: Typecheck + full test run**

```bash
rtk npx tsc --noEmit
rtk npm test
```

Expected: clean; all suites PASS (kanban.test.ts still imports `Card`/`Board` from "./kanban" via the re-export).

- [ ] **Step 6: Manual verification in the running app**

Run the app (`rtk npm run tauri:dev`, or ask the user to run it if the dev environment is heavy) and check:

1. Open a workspace that had a kanban board → the old cards appear (migration) and `.maestro/board.json` now exists.
2. Add/drag a card in the UI → board.json content updates (check with an editor).
3. Edit board.json externally (add a card object by hand or via `node mcp/dist/index.js` + a `card_add` call) → the new card appears on the board within ~4s.
4. A dir-less quick terminal still shows its localStorage board.

If the full app can't be driven in this session, state exactly which of these were verified and which are pending user verification — do not claim them done.

- [ ] **Step 7: Commit**

```bash
rtk git add src/kanban.ts
rtk git commit -m "feat: kanban board persists to .maestro/board.json (MCP-shared)"
```

---

### Task 8: Docs + install instructions

**Files:**
- Create: `mcp/README.md`
- Modify: `README.md` (add an "MCP server" section — read the file first and match its tone/structure)

**Interfaces:**
- Consumes: everything shipped in Tasks 1–7.
- Produces: user-facing install docs.

- [ ] **Step 1: Write `mcp/README.md`**

```markdown
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
| `card_move` | Move a card to another list / position |
| `card_delete` | Delete a card |
| `card_done` | Move a card to Done + attach git change evidence |
| `list_add` / `list_rename` / `list_delete` | Manage lists |

Cards and lists are addressed by id (from `board_get`) or by title; ambiguous
titles are rejected with a hint to use the id. Labels:
`green | yellow | orange | red | purple | blue`. Due dates: `yyyy-mm-dd`.

## How it stays in sync

Every tool call re-reads `.maestro/board.json`, applies the change, and writes
it back atomically. The Maestro app watches the file and re-renders within a
few seconds; UI edits land in the same file, so the next tool call sees them.
```

- [ ] **Step 2: Add the section to the root README**

Read `README.md` first; add a short "MCP server (agent ⇄ board)" section near the kanban/agent-bridge docs (or features list) that links to `mcp/README.md` and shows the one-line install command. Match the existing heading style — do not restructure the file.

- [ ] **Step 3: Commit**

```bash
rtk git add mcp/README.md README.md
rtk git commit -m "docs: maestro-mcp install and tool reference"
```

- [ ] **Step 4: Publishing note (manual, user-driven)**

Do NOT run `npm publish`. Tell the user: publishing to npm requires their npm
account — `cd mcp && npm publish` after `npm login` (the `prepublishOnly` hook
builds and tests). Until then, the local-checkout install command from
`mcp/README.md` works.

---

## Final verification (after all tasks)

- [ ] `rtk npm test` (root) — PASS
- [ ] `rtk npm --prefix mcp test` — PASS
- [ ] `rtk npx tsc --noEmit` — clean
- [ ] Manual app check from Task 7 Step 6 completed or explicitly handed to the user
- [ ] End-to-end: `claude mcp add` (local dist path) in a test workspace, ask the agent to `card_add`, see the card on the Maestro board
