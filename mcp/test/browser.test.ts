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
