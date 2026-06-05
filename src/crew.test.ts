import { describe, it, expect } from "vitest";
import { CLI_PRESETS, parseCommand, expandCrew, runLimited, launchSpec, type CrewState } from "./crew";

function emptyCrew(): CrewState {
  return { counts: {}, custom: "", customCount: 0 };
}

describe("CLI registry", () => {
  it("includes claude, codex, gemini and a powershell shell", () => {
    const ids = CLI_PRESETS.map((p) => p.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("gemini");
    const ps = CLI_PRESETS.find((p) => p.id === "powershell");
    expect(ps?.program).toBe("powershell.exe");
    expect(ps?.args).toEqual(["-NoLogo"]);
    expect(ps?.shell).toBe(true);
  });
});

describe("parseCommand", () => {
  it("splits a command into program + args", () => {
    expect(parseCommand("aider --model gpt-4")).toEqual({
      program: "aider",
      args: ["--model", "gpt-4"],
    });
  });
  it("returns empty program for blank input", () => {
    expect(parseCommand("   ")).toEqual({ program: "", args: [] });
  });
});

describe("expandCrew", () => {
  it("repeats each preset by its count, in registry order", () => {
    const s: CrewState = { ...emptyCrew(), counts: { claude: 2, codex: 1 } };
    const out = expandCrew(s).map((p) => p.id);
    expect(out).toEqual(["claude", "claude", "codex"]);
  });
  it("appends custom entries when command + count are set", () => {
    const s: CrewState = { counts: { claude: 1 }, custom: "aider", customCount: 2 };
    const out = expandCrew(s);
    expect(out.map((p) => p.id)).toEqual(["claude", "custom", "custom"]);
    expect(out[1]).toMatchObject({ program: "aider", args: [], badge: "custom" });
  });
  it("skips an empty custom command even if count > 0", () => {
    const s: CrewState = { counts: {}, custom: "   ", customCount: 3 };
    expect(expandCrew(s)).toEqual([]);
  });
  it("returns empty for an empty crew", () => {
    expect(expandCrew(emptyCrew())).toEqual([]);
  });
});

describe("launchSpec", () => {
  it("runs real .exe binaries directly (case-insensitive)", () => {
    expect(launchSpec("powershell.exe", ["-NoLogo"])).toEqual({
      program: "powershell.exe",
      args: ["-NoLogo"],
    });
    expect(launchSpec("CMD.EXE", [])).toEqual({ program: "CMD.EXE", args: [] });
  });
  it("wraps npm/script CLIs through cmd.exe /c so PATHEXT resolves the shim", () => {
    expect(launchSpec("codex", [])).toEqual({ program: "cmd.exe", args: ["/c", "codex"] });
    expect(launchSpec("claude", ["--foo"])).toEqual({
      program: "cmd.exe",
      args: ["/c", "claude", "--foo"],
    });
  });
});

describe("runLimited", () => {
  it("runs every task and preserves order", async () => {
    const tasks = [1, 2, 3, 4, 5].map((n) => () => Promise.resolve(n * 10));
    expect(await runLimited(tasks, 2)).toEqual([10, 20, 30, 40, 50]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const make = () => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return true;
    };
    const tasks = Array.from({ length: 10 }, make);
    await runLimited(tasks, 3);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles an empty task list", async () => {
    expect(await runLimited([], 3)).toEqual([]);
  });
});
