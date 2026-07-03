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
