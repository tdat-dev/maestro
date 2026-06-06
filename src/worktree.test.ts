import { describe, it, expect } from "vitest";
import { slug, branchName } from "./worktree";

describe("slug", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slug("Claude Code #1")).toBe("claude-code-1");
    expect(slug("  weird//name__")).toBe("weird-name");
  });
});

describe("branchName", () => {
  it("namespaces under maestro/ with a short id suffix", () => {
    expect(branchName("Claude Code", "a1b2c3")).toBe("maestro/claude-code-a1b2c3");
  });
  it("never produces an empty segment", () => {
    expect(branchName("", "x9")).toBe("maestro/agent-x9");
  });
});
