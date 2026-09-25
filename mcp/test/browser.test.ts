// @vitest-environment node
import { describe, it, expect } from "vitest";
import { HubClient } from "../src/browser.js";

describe("browser tools", () => {
  it("says Maestro isn't running when there is no hub to reach", async () => {
    const hub = new HubClient("Ana", () => {
      throw new Error("ENOENT");
    });
    const r = await hub.call("tabs", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Maestro isn't running") });
  });

  it("reports a closed port as a connection problem, not a hang", async () => {
    const hub = new HubClient("Ana", () => ({ port: 1, token: "t" }));
    const r = await hub.call("tabs", {});
    expect(r.isError).toBe(true);
  }, 15_000); // Windows takes ~2s to refuse a localhost connection
});

import { uploadPaths, gifPath } from "../src/browser.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("upload and recording paths", () => {
  it("resolves uploads from the workspace and refuses files that aren't there", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-up-"));
    fs.writeFileSync(path.join(dir, "a.png"), "x");
    expect(uploadPaths(["a.png"], dir)).toEqual([path.join(dir, "a.png")]);
    expect(() => uploadPaths(["missing.png"], dir)).toThrow(/No such file/);
  });

  it("saves recordings under .maestro/recordings, named after the agent and the time", () => {
    const p = gifPath("D:/w", "Ana Lê", new Date("2026-09-25T10:20:30Z"));
    expect(p).toBe(path.join("D:/w", ".maestro", "recordings", "Ana_L_-2026-09-25T10-20-30.gif"));
  });
});
