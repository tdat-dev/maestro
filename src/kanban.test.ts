import { describe, it, expect } from "vitest";
import { cardToAgentText, boardToMarkdown, type Card, type Board } from "./kanban";

const mkCard = (over: Partial<Card> = {}): Card => ({
  id: "c1",
  title: "Do the thing",
  desc: "",
  labels: [],
  due: null,
  checklist: [],
  ...over,
});

describe("cardToAgentText", () => {
  it("sends just the title when there is nothing else", () => {
    expect(cardToAgentText(mkCard())).toBe("Task: Do the thing");
  });

  it("appends the description under the title", () => {
    const got = cardToAgentText(mkCard({ desc: "  wire up the API  " }));
    expect(got).toBe("Task: Do the thing\n\nwire up the API");
  });

  it("lists only UNCHECKED checklist items", () => {
    const got = cardToAgentText(
      mkCard({
        checklist: [
          { id: "1", text: "already done", done: true },
          { id: "2", text: "still open", done: false },
        ],
      }),
    );
    expect(got).toBe("Task: Do the thing\n\n- [ ] still open");
  });

  it("never ends with a newline (drop must not auto-submit)", () => {
    const got = cardToAgentText(
      mkCard({ desc: "d", checklist: [{ id: "1", text: "x", done: false }] }),
    );
    expect(got.endsWith("\n")).toBe(false);
  });
});

describe("boardToMarkdown", () => {
  it("renders one section per list with card checkboxes", () => {
    const board: Board = {
      lists: [
        {
          id: "l1",
          title: "To do",
          cards: [mkCard({ id: "a", title: "First", desc: "detail" })],
        },
        { id: "l2", title: "Done", cards: [mkCard({ id: "b", title: "Shipped", done: { repoRoot: "r", files: [], at: 0 } })] },
      ],
    };
    const md = boardToMarkdown(board);
    expect(md).toContain("## To do (1)");
    expect(md).toContain("- [ ] First");
    expect(md).toContain("  detail");
    expect(md).toContain("## Done (1)");
    expect(md).toContain("- [x] Shipped");
  });

  it("marks an empty list", () => {
    const board: Board = { lists: [{ id: "l1", title: "Doing", cards: [] }] };
    expect(boardToMarkdown(board)).toContain("## Doing (0)\n\n_(empty)_");
  });

  it("nests checklist items under their card", () => {
    const board: Board = {
      lists: [
        {
          id: "l1",
          title: "To do",
          cards: [
            mkCard({
              title: "Parent",
              checklist: [
                { id: "1", text: "sub a", done: true },
                { id: "2", text: "sub b", done: false },
              ],
            }),
          ],
        },
      ],
    };
    const md = boardToMarkdown(board);
    expect(md).toContain("- [ ] Parent");
    expect(md).toContain("  - [x] sub a");
    expect(md).toContain("  - [ ] sub b");
  });
});
