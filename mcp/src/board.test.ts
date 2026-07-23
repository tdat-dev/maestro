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

  it("legacy cards without assignee still normalize", () => {
    const b = normalizeBoard({ lists: [{ id: "l1", title: "To do", cards: [{ id: "c1", title: "old" }] }] });
    expect(b.lists[0].cards[0].assignee).toBeUndefined();
  });
});
