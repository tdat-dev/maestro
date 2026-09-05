// The fleet switcher is how you find one agent among many, so its pure core —
// filter, status grouping, and the flat order that ↑/↓ and Ctrl+1..9 index into
// — has to stay correct as the fleet grows. The DOM controller is verified live.

import { describe, it, expect } from "vitest";
import { matchAgent, filterFleet, groupRows, flatOrder, whereLabel } from "./switcher";
import { type FleetPane } from "./agentbridge";

const NOW = 1_000_000;

function pane(p: Partial<FleetPane> & { id: string; name: string }): FleetPane {
  return {
    color: "#c6f135",
    wsId: "ws1",
    wsName: "app",
    running: true,
    attention: false,
    spawnedAt: NOW - 5000,
    lastOutputAt: NOW, // active by default (recent output)
    ...p,
  };
}

describe("matchAgent / filterFleet", () => {
  const rows = [
    pane({ id: "1", name: "Ana", badge: "claude", wsName: "maestro", branch: "feat/x" }),
    pane({ id: "2", name: "Bob", badge: "codex", wsName: "quy", cwd: "D:/quy/api" }),
  ];

  it("matches on name, CLI, workspace, branch and folder", () => {
    expect(matchAgent(rows[0], "ana")).toBe(true);
    expect(matchAgent(rows[0], "claude")).toBe(true);
    expect(matchAgent(rows[0], "maestro")).toBe(true);
    expect(matchAgent(rows[0], "feat")).toBe(true);
    expect(matchAgent(rows[1], "api")).toBe(true); // basename of cwd is in the haystack
  });

  it("is case-insensitive and requires every word to hit", () => {
    expect(matchAgent(rows[0], "ANA CLAUDE")).toBe(true);
    expect(matchAgent(rows[0], "ana codex")).toBe(false);
  });

  it("empty query keeps everything", () => {
    expect(filterFleet(rows, "  ")).toHaveLength(2);
    expect(filterFleet(rows, "bob")).toEqual([rows[1]]);
  });
});

describe("groupRows", () => {
  it("orders groups needs → running → idle → stopped and drops empties", () => {
    const rows = [
      pane({ id: "idle", name: "I", lastOutputAt: NOW - 60_000 }), // quiet → idle
      pane({ id: "stop", name: "S", running: false }),
      pane({ id: "need", name: "N", attention: true }),
      pane({ id: "run", name: "R", lastOutputAt: NOW }), // recent → active
    ];
    const groups = groupRows(rows, NOW);
    expect(groups.map((g) => g.key)).toEqual(["needs", "active", "idle", "stopped"]);
    expect(groups.map((g) => g.label)).toEqual(["Needs you", "Running", "Idle", "Stopped"]);
    expect(groups.every((g) => g.rows.length === 1)).toBe(true);
  });

  it("omits a status with no members", () => {
    const groups = groupRows([pane({ id: "a", name: "A", attention: true })], NOW);
    expect(groups.map((g) => g.key)).toEqual(["needs"]);
  });
});

describe("flatOrder (quick-jump / arrow index)", () => {
  it("is the grouped order flattened top to bottom", () => {
    const rows = [
      pane({ id: "run", name: "R" }),
      pane({ id: "need", name: "N", attention: true }),
    ];
    const flat = flatOrder(rows, NOW);
    // needs-you ranks first, so Ctrl+1 jumps to the agent waiting on you.
    expect(flat.map((r) => r.id)).toEqual(["need", "run"]);
    expect(flat[0].status).toBe("needs");
  });

  it("is empty for an empty fleet", () => {
    expect(flatOrder([], NOW)).toEqual([]);
    expect(groupRows([], NOW)).toEqual([]);
  });
});

describe("whereLabel", () => {
  it("prefers the branch, falls back to the folder name, else blank", () => {
    expect(whereLabel(pane({ id: "1", name: "A", branch: "feat/y", cwd: "D:/app" }))).toBe("feat/y");
    expect(whereLabel(pane({ id: "2", name: "B", cwd: "D:/proj/web" }))).toBe("web");
    expect(whereLabel(pane({ id: "3", name: "C", cwd: null }))).toBe("");
  });
});
