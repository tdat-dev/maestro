import { describe, expect, it } from "vitest";
import { deriveTaskState, statusLine, STATE_RANK, WORKING_MS, type TaskFacts } from "./taskstate";

const NOW = 1_000_000;
const ASKING = `
 Do you want to proceed?
 ❯ 1. Yes
   2. No, and tell Claude what to do differently (esc)
`;
const facts = (over: Partial<TaskFacts>): TaskFacts => ({
  running: true, lastOutputAt: NOW - 60_000, screen: "", changedFiles: 0, ...over,
});

describe("deriveTaskState", () => {
  it("stopped when the process is gone, whatever is on screen", () => {
    expect(deriveTaskState(facts({ running: false, screen: ASKING }), NOW).state).toBe("stopped");
  });

  it("needs you when a prompt is on screen, even right after output", () => {
    const s = deriveTaskState(facts({ screen: ASKING, lastOutputAt: NOW - 100 }), NOW);
    expect(s.state).toBe("needs");
    expect(s.ask?.options).toHaveLength(2);
  });

  it("working while output is recent", () => {
    expect(deriveTaskState(facts({ lastOutputAt: NOW - (WORKING_MS - 1) }), NOW).state).toBe("working");
  });

  it("ready to review when it went quiet with changes on its branch", () => {
    expect(deriveTaskState(facts({ changedFiles: 3 }), NOW).state).toBe("review");
  });

  it("idle when quiet with no changes, or when changes are unknown", () => {
    expect(deriveTaskState(facts({ changedFiles: 0 }), NOW).state).toBe("idle");
    expect(deriveTaskState(facts({ changedFiles: null }), NOW).state).toBe("idle");
  });

  it("ranks needs above review above working", () => {
    expect(STATE_RANK.needs).toBeLessThan(STATE_RANK.review);
    expect(STATE_RANK.review).toBeLessThan(STATE_RANK.working);
    expect(STATE_RANK.idle).toBeLessThan(STATE_RANK.stopped);
  });
});

describe("statusLine", () => {
  it("says what the agent wants in plain words", () => {
    const run = deriveTaskState(facts({ screen: " Bash command\n\n   npm test\n\n" + ASKING }), NOW);
    expect(statusLine("Ana", run)).toBe("Ana wants to run npm test");
    expect(statusLine("Cy", deriveTaskState(facts({ changedFiles: 2 }), NOW))).toBe("Cy is done, changes ready to review");
    expect(statusLine("Hal", deriveTaskState(facts({}), NOW))).toBe("Hal is waiting for a task");
  });
});
