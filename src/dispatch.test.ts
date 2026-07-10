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
    expect(p).toContain("card_move");
    expect(p).toContain('"Doing"');
    expect(p).toContain("card_done");
  });

  it("skips finished checklist items and empty desc", () => {
    const card = mkCard("Tidy");
    card.checklist = [{ id: "i1", text: "done thing", done: true }];
    const p = dispatchPrompt(card);
    expect(p).not.toContain("done thing");
    expect(p.startsWith("Task: Tidy")).toBe(true);
  });
});
