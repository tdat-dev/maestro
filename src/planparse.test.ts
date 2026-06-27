import { describe, it, expect } from "vitest";
import { parsePlan } from "./planparse";

describe("parsePlan", () => {
  it("parses a JSON array of task objects", () => {
    const got = parsePlan('[{"title":"Add auth","desc":"jwt","label":"blue"},{"title":"Tests"}]');
    expect(got).toEqual([
      { title: "Add auth", desc: "jwt", label: "blue" },
      { title: "Tests" },
    ]);
  });

  it("accepts a { tasks: [...] } wrapper and string items", () => {
    expect(parsePlan('{"tasks":["one","two"]}')).toEqual([{ title: "one" }, { title: "two" }]);
  });

  it("drops invalid labels but keeps the task", () => {
    expect(parsePlan('[{"title":"x","label":"chartreuse"}]')).toEqual([{ title: "x" }]);
  });

  it("falls back to a markdown checklist", () => {
    const md = "# Plan\n- [ ] First task\n- [x] Second task\n* Third\n1. Fourth";
    expect(parsePlan(md).map((t) => t.title)).toEqual([
      "First task",
      "Second task",
      "Third",
      "Fourth",
    ]);
  });

  it("returns [] for empty or junk", () => {
    expect(parsePlan("")).toEqual([]);
    expect(parsePlan("just a sentence with no list")).toEqual([]);
  });
});
