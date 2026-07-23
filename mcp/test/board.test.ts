import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadBoard,
  saveBoard,
  boardPath,
  defaultBoard,
  normalizeBoard,
  BoardError,
  uid,
  type Board,
} from "../src/board.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-mcp-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("uid", () => {
  it("prefixes and never repeats", () => {
    const a = uid("c");
    const b = uid("c");
    expect(a.startsWith("c")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("loadBoard", () => {
  it("returns the default 3-list board when board.json is missing", () => {
    const b = loadBoard(dir);
    expect(b.lists.map((l) => l.title)).toEqual(["To do", "Doing", "Done"]);
  });

  it("round-trips through saveBoard", () => {
    const b = defaultBoard();
    b.lists[0].cards.push({
      id: uid("c"),
      title: "hello",
      desc: "",
      labels: ["blue"],
      due: null,
      checklist: [],
    });
    saveBoard(dir, b);
    const again = loadBoard(dir);
    expect(again.lists[0].cards[0].title).toBe("hello");
    expect(again.lists[0].cards[0].labels).toEqual(["blue"]);
  });

  it("writes the versioned wrapper", () => {
    saveBoard(dir, defaultBoard());
    const raw = JSON.parse(fs.readFileSync(boardPath(dir), "utf8"));
    expect(raw.version).toBe(2);
    expect(Array.isArray(raw.lists)).toBe(true);
  });

  it("throws BoardError on invalid JSON and leaves the file untouched", () => {
    fs.mkdirSync(path.join(dir, ".maestro"), { recursive: true });
    fs.writeFileSync(boardPath(dir), "{not json", "utf8");
    // Persistently-invalid JSON survives loadBoard's one torn-read retry and
    // surfaces the softened "may be mid-write" wording, not "fix or delete".
    expect(() => loadBoard(dir)).toThrow(BoardError);
    expect(() => loadBoard(dir)).toThrow(/mid-write/);
    expect(fs.readFileSync(boardPath(dir), "utf8")).toBe("{not json");
  });

  it("throws BoardError when lists is missing", () => {
    fs.mkdirSync(path.join(dir, ".maestro"), { recursive: true });
    fs.writeFileSync(boardPath(dir), JSON.stringify({ version: 2 }), "utf8");
    expect(() => loadBoard(dir)).toThrow(BoardError);
  });
});

describe("normalizeBoard", () => {
  it("fills defaults for sparse cards", () => {
    const b: Board = normalizeBoard({
      lists: [{ id: "l1", title: "T", cards: [{ id: "c1", title: "x" }] }],
    });
    const c = b.lists[0].cards[0];
    expect(c.desc).toBe("");
    expect(c.labels).toEqual([]);
    expect(c.due).toBeNull();
    expect(c.checklist).toEqual([]);
    expect(c.done).toBeUndefined();
  });

  it("keeps done evidence when well-formed", () => {
    const b = normalizeBoard({
      lists: [
        {
          id: "l1",
          title: "Done",
          cards: [
            {
              id: "c1",
              title: "x",
              done: { repoRoot: "r", files: ["a.ts"], summary: "s", at: 5 },
            },
          ],
        },
      ],
    });
    expect(b.lists[0].cards[0].done).toEqual({
      repoRoot: "r",
      files: ["a.ts"],
      summary: "s",
      at: 5,
    });
  });
});

describe("saveBoard", () => {
  it("creates .maestro/ on first write and leaves no tmp file", () => {
    saveBoard(dir, defaultBoard());
    expect(fs.existsSync(boardPath(dir))).toBe(true);
    const leftovers = fs
      .readdirSync(path.join(dir, ".maestro"))
      .filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
