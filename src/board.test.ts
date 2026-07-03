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
