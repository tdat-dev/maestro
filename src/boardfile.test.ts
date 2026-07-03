import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultBoard } from "./board";

// In-memory fake of the Tauri fs IPC: root+path → { content, mtime }.
const files = new Map<string, { content: string; mtime: number }>();
let clock = 100;
const key = (root: string, path: string) => `${root}|${path}`;

// Mirrors the real Tauri rejection shape for a missing path: `scoped()` in
// src-tauri/src/core/fs.rs fails canonicalize() with
// `CommandError::Failed(format!("no such path: {e}"))`, which serializes to
// JS as `{ Failed: "no such path: ..." }` (see src/editor.ts's `{ Conflict }`
// handling for the same pattern with the other variant).
const notFound = () => ({ Failed: "no such path: The system cannot find the path specified. (os error 3)" });

vi.mock("./ipc", () => ({
  fsReadFile: vi.fn(async (root: string, path: string) => {
    const f = files.get(key(root, path));
    if (!f) throw notFound();
    return f;
  }),
  fsStat: vi.fn(async (root: string, path: string) => {
    const f = files.get(key(root, path));
    if (!f) throw notFound();
    return { mtime: f.mtime };
  }),
  fsWriteFile: vi.fn(async (root: string, path: string, content: string, expectedMtime: number | null) => {
    const f = files.get(key(root, path));
    if (expectedMtime !== null && f && f.mtime !== expectedMtime) throw new Error("Conflict");
    clock += 1;
    files.set(key(root, path), { content, mtime: clock });
    return { mtime: clock };
  }),
  fsCreateFile: vi.fn(async (root: string, path: string) => {
    if (files.has(key(root, path))) throw new Error("Exists");
    clock += 1;
    files.set(key(root, path), { content: "", mtime: clock });
  }),
  fsCreateDir: vi.fn(async () => {}),
}));

import {
  BOARD_JSON_REL,
  BoardFileCorrupt,
  readBoardFile,
  writeBoardFile,
  statBoardFile,
  serializeBoard,
} from "./boardfile";
import { fsReadFile, fsStat } from "./ipc";

beforeEach(() => {
  files.clear();
});

describe("boardfile", () => {
  it("statBoardFile returns null when missing", async () => {
    expect(await statBoardFile("D:\\ws")).toBeNull();
  });

  it("readBoardFile returns null when missing", async () => {
    expect(await readBoardFile("D:\\ws")).toBeNull();
  });

  it("write → stat → read round-trips", async () => {
    const b = defaultBoard();
    const mtime = await writeBoardFile("D:\\ws", b, null);
    expect(await statBoardFile("D:\\ws")).toBe(mtime);
    const bf = await readBoardFile("D:\\ws");
    expect(bf?.mtime).toBe(mtime);
    expect(bf?.board.lists.map((l) => l.title)).toEqual(["To do", "Doing", "Done"]);
  });

  it("serializes with the version wrapper", () => {
    const raw = JSON.parse(serializeBoard(defaultBoard()));
    expect(raw.version).toBe(2);
  });

  it("throws BoardFileCorrupt on invalid JSON", async () => {
    files.set(`D:\\ws|${BOARD_JSON_REL}`, { content: "{oops", mtime: 1 });
    await expect(readBoardFile("D:\\ws")).rejects.toBeInstanceOf(BoardFileCorrupt);
  });

  it("throws BoardFileCorrupt when lists is missing", async () => {
    files.set(`D:\\ws|${BOARD_JSON_REL}`, { content: "{}", mtime: 1 });
    await expect(readBoardFile("D:\\ws")).rejects.toBeInstanceOf(BoardFileCorrupt);
  });

  it("propagates a Conflict from a stale expectedMtime", async () => {
    const b = defaultBoard();
    const m1 = await writeBoardFile("D:\\ws", b, null);
    await writeBoardFile("D:\\ws", b, m1); // bumps mtime
    await expect(writeBoardFile("D:\\ws", b, m1)).rejects.toThrow("Conflict");
  });

  it("second write does not re-create the file", async () => {
    const b = defaultBoard();
    const m1 = await writeBoardFile("D:\\ws", b, null);
    const m2 = await writeBoardFile("D:\\ws", b, m1);
    expect(m2).toBeGreaterThan(m1);
  });

  it("readBoardFile propagates a non-not-found error instead of returning null", async () => {
    (fsReadFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      Failed: "file too large to open (>2 MB)",
    });
    await expect(readBoardFile("D:\\ws")).rejects.toMatchObject({
      Failed: "file too large to open (>2 MB)",
    });
  });

  it("readBoardFile propagates a permission-style error instead of returning null", async () => {
    (fsReadFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      Failed: "Access is denied. (os error 5)",
    });
    await expect(readBoardFile("D:\\ws")).rejects.toBeTruthy();
  });

  it("statBoardFile propagates a non-not-found error instead of returning null", async () => {
    (fsStat as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      Failed: "binary file",
    });
    await expect(statBoardFile("D:\\ws")).rejects.toMatchObject({ Failed: "binary file" });
  });
});
