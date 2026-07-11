import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readFleet,
  queueMessage,
  fleetPath,
  outboxPath,
  readAgentScreen,
  queueSpawn,
  spawnPath,
} from "./fleet.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-fleet-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readFleet", () => {
  it("returns [] when no file", () => {
    expect(readFleet(dir)).toEqual([]);
  });

  it("reads an {agents:[...]} roster and normalizes bad statuses", () => {
    fs.mkdirSync(path.join(dir, ".maestro"));
    fs.writeFileSync(
      fleetPath(dir),
      JSON.stringify({
        agents: [
          { id: "a", name: "Claude #1", status: "needs", workspace: "demo" },
          { id: "b", name: "Codex #1", status: "weird" },
          { name: "no-id", status: "active" },
          { status: "active" }, // no name → dropped
        ],
      }),
    );
    const f = readFleet(dir);
    expect(f.map((x) => x.name)).toEqual(["Claude #1", "Codex #1", "no-id"]);
    expect(f[1].status).toBe("idle"); // "weird" normalized
  });

  it("returns [] on corrupt json without throwing", () => {
    fs.mkdirSync(path.join(dir, ".maestro"));
    fs.writeFileSync(fleetPath(dir), "{not json");
    expect(readFleet(dir)).toEqual([]);
  });
});

describe("queueMessage", () => {
  it("appends a jsonl line and creates .maestro", () => {
    const m = queueMessage(dir, { from: "Claude #1", to: "Codex #1", message: "  ping ", now: 5 });
    expect(m).toEqual({ ts: 5, from: "Claude #1", to: "Codex #1", message: "ping" });
    const lines = fs.readFileSync(outboxPath(dir), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).message).toBe("ping");
  });

  it("defaults from to 'agent' and to to null (broadcast)", () => {
    const m = queueMessage(dir, { message: "hi all", now: 1 });
    expect(m.from).toBe("agent");
    expect(m.to).toBeNull();
  });

  it("appends, not overwrites", () => {
    queueMessage(dir, { message: "one", now: 1 });
    queueMessage(dir, { message: "two", now: 2 });
    const lines = fs.readFileSync(outboxPath(dir), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("rejects an empty message", () => {
    expect(() => queueMessage(dir, { message: "   ", now: 1 })).toThrow();
  });
});

describe("readAgentScreen", () => {
  it("returns the named agent's screen (case-insensitive), null if absent", () => {
    fs.mkdirSync(path.join(dir, ".maestro"));
    fs.writeFileSync(
      fleetPath(dir),
      JSON.stringify({
        agents: [
          { id: "a", name: "Claude #1", status: "active", screen: "> hello world" },
          { id: "b", name: "Codex #1", status: "idle", screen: "" },
        ],
      }),
    );
    expect(readAgentScreen(dir, "claude #1")).toBe("> hello world");
    expect(readAgentScreen(dir, "Codex #1")).toBe("");
    expect(readAgentScreen(dir, "nobody")).toBeNull();
  });
});

describe("queueSpawn", () => {
  it("appends a spawn request, clamps count 1..6, defaults", () => {
    const r = queueSpawn(dir, { from: "Conductor", cli: "claude", task: " build X ", count: 9, now: 3 });
    expect(r).toEqual({ ts: 3, from: "Conductor", cli: "claude", task: "build X", count: 6 });
    const line = JSON.parse(fs.readFileSync(spawnPath(dir), "utf8").trim());
    expect(line.cli).toBe("claude");
  });
  it("defaults from=agent, task=null, count=1; rejects empty cli", () => {
    const r = queueSpawn(dir, { cli: "codex", now: 1 });
    expect(r).toMatchObject({ from: "agent", task: null, count: 1 });
    expect(() => queueSpawn(dir, { cli: "  ", now: 1 })).toThrow();
  });
});
