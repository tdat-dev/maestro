import { describe, it, expect, vi } from "vitest";

vi.mock("./ipc", () => ({
  fsReadFile: vi.fn(),
  fsWriteFile: vi.fn(),
  fsStat: vi.fn(),
  fsCreateDir: vi.fn(),
  fsCreateFile: vi.fn(),
}));

import { serializeFleet, parseOutboxLine, parseSpawnLine } from "./fleetbridge";

describe("serializeFleet", () => {
  it("emits an {agents:[...]} roster tagged with the workspace name", () => {
    const s = serializeFleet({
      dir: "D:\\demo",
      name: "demo",
      agents: [{ id: "p1", name: "Claude #1", status: "needs" }],
    });
    expect(JSON.parse(s)).toEqual({
      agents: [{ id: "p1", name: "Claude #1", status: "needs", workspace: "demo", screen: "" }],
    });
  });
});

describe("parseOutboxLine", () => {
  it("parses a targeted message", () => {
    expect(parseOutboxLine('{"to":"Codex #1","message":"do X"}')).toEqual({
      to: "Codex #1",
      message: "do X",
    });
  });
  it("treats missing/blank to as a broadcast (null)", () => {
    expect(parseOutboxLine('{"message":"hello"}')).toEqual({ to: null, message: "hello" });
    expect(parseOutboxLine('{"to":"  ","message":"hi"}')).toEqual({ to: null, message: "hi" });
  });
  it("returns null for blank, non-json, or message-less lines", () => {
    expect(parseOutboxLine("")).toBeNull();
    expect(parseOutboxLine("not json")).toBeNull();
    expect(parseOutboxLine('{"to":"x"}')).toBeNull();
    expect(parseOutboxLine('{"message":"   "}')).toBeNull();
  });
});

describe("parseSpawnLine", () => {
  it("parses a spawn request, clamps count, defaults task", () => {
    expect(parseSpawnLine('{"cli":"claude","task":"build X","count":3}')).toEqual({
      cli: "claude",
      task: "build X",
      count: 3,
    });
    expect(parseSpawnLine('{"cli":"codex"}')).toEqual({ cli: "codex", task: null, count: 1 });
    expect(parseSpawnLine('{"cli":"x","count":99}')?.count).toBe(6);
  });
  it("returns null without a cli or for junk", () => {
    expect(parseSpawnLine('{"task":"x"}')).toBeNull();
    expect(parseSpawnLine("nope")).toBeNull();
    expect(parseSpawnLine("")).toBeNull();
  });
});
