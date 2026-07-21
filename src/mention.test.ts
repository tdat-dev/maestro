import { describe, it, expect } from "vitest";
import { activeMention, matchNames, splitMentions } from "./mention";

describe("activeMention", () => {
  it("returns the @token being typed at the caret", () => {
    expect(activeMention("@An", 3)).toBe("An");
    expect(activeMention("hi @", 4)).toBe("");
    expect(activeMention("hi @Bo", 6)).toBe("Bo");
  });
  it("is null when the caret is not inside an @token", () => {
    expect(activeMention("hi there", 8)).toBeNull();
    expect(activeMention("@Ana x", 6)).toBeNull(); // caret after a space
    expect(activeMention("", 0)).toBeNull();
  });
});

describe("matchNames", () => {
  it("matches by case-insensitive prefix; empty query matches all", () => {
    expect(matchNames("a", ["Ana", "Bob", "Ada"])).toEqual(["Ana", "Ada"]);
    expect(matchNames("", ["Ana", "Bob"])).toEqual(["Ana", "Bob"]);
    expect(matchNames("z", ["Ana"])).toEqual([]);
  });
});

describe("splitMentions", () => {
  const names = ["Ana", "Bob"];
  it("fans a multi-mention line out into per-agent messages", () => {
    expect(splitMentions("@Ana run tests @Bob deploy", names)).toEqual([
      { name: "Ana", body: "run tests" },
      { name: "Bob", body: "deploy" },
    ]);
  });
  it("routes leading text (before any mention) to the whole fleet", () => {
    expect(splitMentions("do it @Ana now", names)).toEqual([
      { name: null, body: "do it" },
      { name: "Ana", body: "now" },
    ]);
  });
  it("no mention → one whole-fleet segment; blank → nothing", () => {
    expect(splitMentions("hello everyone", names)).toEqual([{ name: null, body: "hello everyone" }]);
    expect(splitMentions("   ", names)).toEqual([]);
  });
  it("ignores an @word that is not a known agent", () => {
    expect(splitMentions("@nobody hi", names)).toEqual([{ name: null, body: "@nobody hi" }]);
  });
});
