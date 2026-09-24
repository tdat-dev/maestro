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
  it("falls back to the first free 'Project N'", () => {
    expect(nextWorkspaceName(null, [])).toBe("Project 1");
    expect(nextWorkspaceName(null, ["Project 1", "Project 2"])).toBe("Project 3");
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

import { runDir, sameFolder } from "./workspaces";
describe("runDir", () => {
  it("starts an agent in its worktree, else the project, else home, without a trailing slash", () => {
    expect(runDir({ worktree: "D:\\wt\\a", cwd: "D:\\app" }, "C:\\Users\\me")).toBe("D:\\wt\\a");
    expect(runDir({ cwd: "D:\\app\\" }, "C:\\Users\\me")).toBe("D:\\app");
    expect(runDir({ cwd: null }, "C:\\Users\\me\\")).toBe("C:\\Users\\me");
    expect(runDir({ cwd: "C:\\" }, "")).toBe("C:\\");
    expect(runDir({ cwd: "/home/me/" }, "")).toBe("/home/me");
  });
});

describe("sameFolder", () => {
  it("matches a folder whatever its case, slashes or trailing separator", () => {
    expect(sameFolder("D:\\App\\", "d:/app")).toBe(true);
    expect(sameFolder("D:\\app", "D:\\app2")).toBe(false);
    expect(sameFolder(null, "D:\\app")).toBe(false);
  });
});
