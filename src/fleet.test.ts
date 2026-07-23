import { describe, it, expect } from "vitest";
import { paneStatus, sortFleet, needsCount } from "./fleet";
import type { FleetPane } from "./agentbridge";

const now = 1_000_000;
const mk = (over: Partial<FleetPane>): FleetPane => ({
  id: "p",
  name: "Agent",
  color: "#fff",
  wsId: "w",
  wsName: "ws",
  running: true,
  attention: false,
  spawnedAt: now - 5000,
  lastOutputAt: now,
  ...over,
});

describe("paneStatus", () => {
  it("stopped when not running (even if it has an attention flag)", () => {
    expect(paneStatus(mk({ running: false, attention: true }), now)).toBe("stopped");
  });
  it("needs when running + attention", () => {
    expect(paneStatus(mk({ attention: true }), now)).toBe("needs");
  });
  it("active when output is recent", () => {
    expect(paneStatus(mk({ lastOutputAt: now - 500 }), now)).toBe("active");
  });
  it("idle when quiet past the idle window", () => {
    expect(paneStatus(mk({ lastOutputAt: now - 5000 }), now)).toBe("idle");
  });
});

describe("sortFleet", () => {
  it("orders needs → active → idle → stopped, then by name", () => {
    const rows = sortFleet(
      [
        mk({ id: "1", name: "Zeta", running: false }),
        mk({ id: "2", name: "Beta", attention: true }),
        mk({ id: "3", name: "Alpha", lastOutputAt: now - 9000 }),
        mk({ id: "4", name: "Gamma", lastOutputAt: now }),
      ],
      now,
    );
    expect(rows.map((r) => r.name)).toEqual(["Beta", "Gamma", "Alpha", "Zeta"]);
    expect(rows.map((r) => r.status)).toEqual(["needs", "active", "idle", "stopped"]);
  });
});

describe("needsCount", () => {
  it("counts only running agents flagged for attention", () => {
    const panes = [
      mk({ attention: true }),
      mk({ attention: true, running: false }),
      mk({ attention: false }),
    ];
    expect(needsCount(panes, now)).toBe(1);
  });
});
