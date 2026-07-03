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
