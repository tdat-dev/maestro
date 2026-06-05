import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted so the mock factory can safely reference it.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { spawnPty, sendInput, resizePty, killPty } from "./ipc";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("ipc", () => {
  it("spawnPty passes agentId + camelCase args including the channel", async () => {
    await spawnPty("agent-1", "powershell.exe", ["-NoLogo"], 80, 24, () => {});
    expect(invoke).toHaveBeenCalledWith(
      "pty_spawn",
      expect.objectContaining({
        agentId: "agent-1",
        program: "powershell.exe",
        args: ["-NoLogo"],
        cols: 80,
        rows: 24,
        onBytes: expect.anything(),
      }),
    );
  });

  it("input / resize / kill are addressed by agentId", async () => {
    await sendInput("agent-2", "ls\r");
    expect(invoke).toHaveBeenCalledWith("pty_input", { agentId: "agent-2", data: "ls\r" });

    await resizePty("agent-2", 120, 40);
    expect(invoke).toHaveBeenCalledWith("pty_resize", { agentId: "agent-2", cols: 120, rows: 40 });

    await killPty("agent-2");
    expect(invoke).toHaveBeenCalledWith("pty_kill", { agentId: "agent-2" });
  });
});
