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
