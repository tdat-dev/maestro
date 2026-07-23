import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { changedFiles } from "../src/git.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-mcp-git-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Generous timeout: these shell out to real git; on a busy/slow disk a bare
// `git init` alone can blow the default 5s and fail the suite spuriously.
describe("changedFiles", { timeout: 60_000 }, () => {
  it("returns [] outside a git repo", () => {
    expect(changedFiles(dir)).toEqual([]);
  });

  it("lists modified and untracked files in a repo", () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(dir, "tracked.txt"), "one", "utf8");
    git("add", ".");
    git("commit", "-m", "init");
    fs.writeFileSync(path.join(dir, "tracked.txt"), "two", "utf8");
    fs.writeFileSync(path.join(dir, "new.txt"), "n", "utf8");
    const files = changedFiles(dir).sort();
    expect(files).toEqual(["new.txt", "tracked.txt"]);
  });
});
