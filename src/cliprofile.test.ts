import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ runs: 0, out: "" }));
vi.mock("./ipc", () => ({ runCapture: async () => { io.runs++; return io.out; } }));

import { cliFacts, parseClaudeInit, profileOf } from "./cliprofile";

const init = (o: object) => JSON.stringify({ type: "system", subtype: "init", ...o });

describe("cliprofile", () => {
  beforeEach(() => { io.runs = 0; });

  it("reads Claude Code's own commands, telling skills and plugins apart", () => {
    const facts = parseClaudeInit([
      JSON.stringify({ type: "system", subtype: "hook_started" }),
      init({ model: "claude-opus-5-5[1m]", slash_commands: ["compact", "impeccable", "codex:rescue"], skills: [{ name: "impeccable" }] }),
    ].join("\n"));
    expect(facts).toEqual({
      model: "claude-opus-5-5[1m]",
      commands: [{ name: "compact", kind: "command" }, { name: "impeccable", kind: "skill" }, { name: "codex:rescue", kind: "plugin" }],
    });
    expect(parseClaudeInit("nothing here")).toBeNull();
  });

  it("asks the CLI once per folder and keeps the answer", async () => {
    io.out = init({ slash_commands: ["review"] });
    const a = await cliFacts("claude", "claude", "D:/one")!;
    await cliFacts("claude", "claude", "D:/one");
    expect(io.runs).toBe(1);
    await cliFacts("claude", "claude", "D:/two");
    expect(io.runs).toBe(2);
    expect(a.commands.map((c) => c.name)).toEqual(["review"]);
    await cliFacts("claude", "claude", "D:/one", true);
    expect(io.runs).toBe(3);
  });

  it("leaves CLIs that can't list their commands to their own menu, with their own model command", () => {
    expect(cliFacts("codex", "codex", "D:/one")).toBeNull();
    expect(profileOf("codex").modelCommand).toBe("/model");
    expect(profileOf("opencode").modelCommand).toBe("/models");
    expect(profileOf("aider").modelCommand).toBeUndefined();
  });
});
