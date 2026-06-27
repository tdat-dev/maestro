import { describe, it, expect } from "vitest";
import { filterEntries, sortEntries, langForFile, resolveConflict } from "./codepanel";
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
