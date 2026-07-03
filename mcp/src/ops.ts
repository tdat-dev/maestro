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
