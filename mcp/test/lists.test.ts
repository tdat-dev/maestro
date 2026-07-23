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
