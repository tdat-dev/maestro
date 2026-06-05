import { describe, it, expect } from "vitest";
import { basename, nextWorkspaceName, pickNextActive, needsCloseConfirm } from "./workspaces";

describe("basename", () => {
  it("takes the last path segment, slash or backslash", () => {
    expect(basename("D:\\WhaleloSource\\app")).toBe("app");
    expect(basename("/home/me/proj/")).toBe("proj");
  });
});

describe("nextWorkspaceName", () => {
  it("uses the directory basename when a dir is given", () => {
    expect(nextWorkspaceName("D:\\projects\\api", [])).toBe("api");
  });
  it("falls back to the first free 'Workspace N'", () => {
    expect(nextWorkspaceName(null, [])).toBe("Workspace 1");
    expect(nextWorkspaceName(null, ["Workspace 1", "Workspace 2"])).toBe("Workspace 3");
  });
});

describe("pickNextActive", () => {
  it("activates the neighbour after the closed tab", () => {
    expect(pickNextActive(["a", "b", "c"], "b")).toBe("c");
  });
  it("activates the last when the closed tab was last", () => {
    expect(pickNextActive(["a", "b", "c"], "c")).toBe("b");
  });
  it("returns null when closing the only tab", () => {
    expect(pickNextActive(["a"], "a")).toBeNull();
  });
});

describe("needsCloseConfirm", () => {
  it("is true only when terminals are running", () => {
    expect(needsCloseConfirm(0)).toBe(false);
    expect(needsCloseConfirm(3)).toBe(true);
  });
});
