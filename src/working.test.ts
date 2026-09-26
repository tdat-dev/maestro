import { describe, expect, it } from "vitest";
import { activityOnScreen, stepDoing } from "./working";
import type { StepItem } from "./chatmodel";

describe("what a working agent is doing", () => {
  it("reads Claude Code's status line: its word, the time and the tokens", () => {
    const screen = "some output\n\n✻ Pondering… (42s · ↓ 1.2k tokens · esc to interrupt)\n\n> \n  ⏵⏵ accept edits on";
    expect(activityOnScreen(screen)).toEqual({ verb: "Pondering…", detail: "42s · 1.2k tokens" });
    expect(activityOnScreen("✽ Thinking... (esc to interrupt · 1m 3s · thinking)")).toEqual({ verb: "Thinking…", detail: "1m 3s · thinking" });
    expect(activityOnScreen("> type here\n? for shortcuts")).toBeNull();
  });

  it("says a running step as what it is doing", () => {
    const step = (verb: string, target: string, code = true) => ({ kind: "step", id: "s", tool: "Bash", verb, target, code, done: false, at: 0 }) as StepItem;
    expect(stepDoing(step("Ran", "npm test"))).toBe("Running npm test");
    expect(stepDoing(step("Edited", "chatview.ts"))).toBe("Editing chatview.ts");
    expect(stepDoing(step("Searched for", "TODO"))).toBe("Searching for TODO");
    expect(stepDoing(step("Did a thing", "x"))).toBe("Did a thing x");
    // a command it described already says what it does
    expect(stepDoing(step("Ran", "Run the tests", false))).toBe("Run the tests");
  });
});
