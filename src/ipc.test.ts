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
  it("spawnPty passes camelCase args including the channel", async () => {
    await spawnPty("powershell.exe", ["-NoLogo"], 80, 24, () => {});
    expect(invoke).toHaveBeenCalledWith(
      "pty_spawn",
      expect.objectContaining({
        program: "powershell.exe",
        args: ["-NoLogo"],
        cols: 80,
        rows: 24,
        onBytes: expect.anything(),
      }),
    );
  });

  it("sendInput / resizePty / killPty call the right commands", async () => {
    await sendInput("ls\r");
    expect(invoke).toHaveBeenCalledWith("pty_input", { data: "ls\r" });

    await resizePty(120, 40);
    expect(invoke).toHaveBeenCalledWith("pty_resize", { cols: 120, rows: 40 });

    await killPty();
    expect(invoke).toHaveBeenCalledWith("pty_kill");
  });
});
