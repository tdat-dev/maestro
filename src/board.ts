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
