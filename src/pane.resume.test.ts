import { describe, expect, it, vi } from "vitest";
vi.mock("./terminal", () => ({ mountTerminal: () => ({}) }));
import { claudeSessionArgs } from "./pane";
import type { AgentSpec } from "./panetypes";

const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({ program: "claude", args: [], cwd: "D:/app", name: "Ana", badge: "claude", color: "", mono: "", ...over });

describe("claudeSessionArgs", () => {
  it("carries on the agent's own conversation when Claude still has it", async () => {
    const s = spec({ sessionId: "11111111-2222-3333-4444-555555555555" });
    expect(await claudeSessionArgs(s, "D:/app", async () => true)).toEqual(["--resume", "11111111-2222-3333-4444-555555555555"]);
    expect(s.sessionId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("starts a new conversation when there is none to carry on", async () => {
    const s = spec({ sessionId: "11111111-2222-3333-4444-555555555555" });
    const args = await claudeSessionArgs(s, "D:/app", async () => false);
    expect(args[0]).toBe("--session-id");
    expect(args[1]).toBe(s.sessionId);
    expect(s.sessionId).not.toBe("11111111-2222-3333-4444-555555555555");
    const fresh = spec();
    expect((await claudeSessionArgs(fresh, "D:/app", async () => true))[0]).toBe("--session-id");
  });

  it("leaves the session to a preset that picks one itself", async () => {
    const s = spec({ args: ["--continue"], sessionId: "x" });
    expect(await claudeSessionArgs(s, "D:/app", async () => true)).toEqual([]);
    expect(s.sessionId).toBeUndefined();
  });
});
