import { describe, it, expect } from "vitest";
import {
  filterEntries,
  sortEntries,
  langForFile,
  resolveConflict,
  isImageFile,
  flattenTree,
  applySelection,
  parentOf,
  parentsOf,
  topLevelOnly,
  isInside,
  iconForFile,
} from "./codepanel";
import type { FsEntry } from "./ipc";

const dir = (name: string): FsEntry => ({ name, is_dir: true, size: 0 });
const file = (name: string): FsEntry => ({ name, is_dir: false, size: 1 });

describe("filterEntries", () => {
  it("hides heavy dirs by default but keeps dotfiles", () => {
    const got = filterEntries([dir("node_modules"), dir(".git"), dir("src"), file(".env")], false);
    expect(got.map((e) => e.name)).toEqual(["src", ".env"]);
  });
  it("shows everything when showHidden is true", () => {
    const got = filterEntries([dir("node_modules"), dir("src")], true);
    expect(got.map((e) => e.name)).toEqual(["node_modules", "src"]);
  });
});

describe("sortEntries", () => {
  it("orders directories first, then case-insensitive by name", () => {
    const got = sortEntries([file("b.ts"), file("A.ts"), dir("zdir")]);
    expect(got.map((e) => e.name)).toEqual(["zdir", "A.ts", "b.ts"]);
  });
});

describe("langForFile", () => {
  it("maps known extensions and falls back to plaintext", () => {
    expect(langForFile("main.ts")).toBe("typescript");
    expect(langForFile("a.rs")).toBe("rust");
    expect(langForFile("README")).toBe("plaintext");
    expect(langForFile("weird.xyz")).toBe("plaintext");
  });
});

describe("isImageFile", () => {
  it("detects common image extensions, case-insensitive", () => {
    expect(isImageFile("logo.png")).toBe(true);
    expect(isImageFile("Photo.JPG")).toBe(true);
    expect(isImageFile("icon.svg")).toBe(true);
    expect(isImageFile("main.ts")).toBe(false);
    expect(isImageFile("README")).toBe(false);
  });
});

describe("flattenTree", () => {
  const children = new Map<string, FsEntry[]>([
    ["", [dir("src"), dir("docs"), file("README.md")]],
    ["src", [dir("core"), file("main.ts")]],
    ["src\\core", [file("fs.rs")]],
  ]);

  it("only walks into expanded folders", () => {
    const rows = flattenTree(children, new Set(["src"]), false);
    expect(rows.map((r) => r.rel)).toEqual(["docs", "src", "src\\core", "src\\main.ts", "README.md"]);
  });

  it("tracks depth for every level", () => {
    const rows = flattenTree(children, new Set(["src", "src\\core"]), false);
    const deep = rows.find((r) => r.rel === "src\\core\\fs.rs");
    expect(deep?.depth).toBe(2);
    expect(rows.find((r) => r.rel === "src")?.depth).toBe(0);
  });

  it("renders an expanded folder as closed until its children load", () => {
    const partial = new Map<string, FsEntry[]>([["", [dir("src")]]]);
    const rows = flattenTree(partial, new Set(["src"]), false);
    expect(rows.map((r) => r.rel)).toEqual(["src"]);
  });
});

describe("applySelection", () => {
  const order = ["a", "b", "c", "d"];

  it("plain click replaces the selection and moves the anchor", () => {
    const got = applySelection(order, new Set(["a", "b"]), "a", "c", "set");
    expect([...got.selected]).toEqual(["c"]);
    expect(got.anchor).toBe("c");
  });

  it("ctrl+click toggles one row without losing the rest", () => {
    const on = applySelection(order, new Set(["a"]), "a", "c", "toggle");
    expect([...on.selected].sort()).toEqual(["a", "c"]);
    const off = applySelection(order, on.selected, "c", "a", "toggle");
    expect([...off.selected]).toEqual(["c"]);
  });

  it("shift+click selects the range and keeps the anchor put", () => {
    const down = applySelection(order, new Set(["b"]), "b", "d", "range");
    expect([...down.selected]).toEqual(["b", "c", "d"]);
    expect(down.anchor).toBe("b");
    // Shrinking the range back re-derives it from the same anchor.
    const back = applySelection(order, down.selected, down.anchor, "c", "range");
    expect([...back.selected]).toEqual(["b", "c"]);
  });

  it("falls back to a plain select when the anchor is gone", () => {
    const got = applySelection(order, new Set(), "deleted", "c", "range");
    expect([...got.selected]).toEqual(["c"]);
  });
});

describe("path helpers", () => {
  it("parentOf walks up one level, root is empty", () => {
    expect(parentOf("src\\core\\fs.rs")).toBe("src\\core");
    expect(parentOf("README.md")).toBe("");
  });

  it("parentsOf dedupes the folders a bulk op has to reload", () => {
    expect(parentsOf(["src\\a.ts", "src\\b.ts", "docs\\x.md", "top.txt"]).sort()).toEqual([
      "",
      "docs",
      "src",
    ]);
  });

  it("topLevelOnly drops paths already covered by a selected ancestor", () => {
    expect(topLevelOnly(["src", "src\\core", "src\\core\\fs.rs", "docs"])).toEqual(["src", "docs"]);
  });

  it("isInside covers self, descendants and the root", () => {
    expect(isInside("src\\core", "src")).toBe(true);
    expect(isInside("src", "src")).toBe(true);
    expect(isInside("srcfoo", "src")).toBe(false);
    expect(isInside("anything", "")).toBe(true);
  });
});

describe("iconForFile", () => {
  it("keys off the extension, case-insensitive", () => {
    expect(iconForFile("main.TS")).toEqual({ glyph: "code", color: "blue" });
    expect(iconForFile("package.json").glyph).toBe("braces");
    expect(iconForFile("logo.png").glyph).toBe("image");
  });
  it("gives known dotfiles their own look and falls back otherwise", () => {
    expect(iconForFile(".gitignore").glyph).toBe("git");
    expect(iconForFile("weird.xyz")).toEqual({ glyph: "file", color: "gray" });
    // A leading dot is a name, not an extension.
    expect(iconForFile(".env").glyph).toBe("file");
  });
});

describe("resolveConflict", () => {
  it("returns ok when disk did not change", () => {
    expect(resolveConflict(false, true)).toBe("ok");
  });
  it("reloads when disk changed and buffer is clean", () => {
    expect(resolveConflict(true, false)).toBe("reload");
  });
  it("warns (banner) when disk changed and buffer is dirty", () => {
    expect(resolveConflict(true, true)).toBe("banner");
  });
});
