import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { loadBoard } from "../src/board.js";

let dir: string;
let client: Client;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-mcp-srv-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(dir);
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const text = (res: unknown): string =>
  (res as { content: { type: string; text: string }[] }).content[0].text;

describe("maestro-mcp server", () => {
  it("lists all board + fleet tools", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "agent_output",
      "agent_spawn",
      "board_get",
      "card_add",
      "card_delete",
      "card_done",
      "card_move",
      "card_update",
      "fleet_send",
      "fleet_status",
      "list_add",
      "list_delete",
      "list_rename",
    ]);
  });

  it("board_get returns the default board without creating the file", async () => {
    const res = await client.callTool({ name: "board_get", arguments: {} });
    const board = JSON.parse(text(res));
    expect(board.lists.map((l: { title: string }) => l.title)).toEqual(["To do", "Doing", "Done"]);
    expect(fs.existsSync(path.join(dir, ".maestro", "board.json"))).toBe(false);
  });

  it("card_add persists to board.json", async () => {
    await client.callTool({
      name: "card_add",
      arguments: { list: "To do", title: "from agent", labels: ["blue"] },
    });
    const board = loadBoard(dir);
    expect(board.lists[0].cards[0].title).toBe("from agent");
  });

  it("card_move + card_update round-trip", async () => {
    await client.callTool({ name: "card_add", arguments: { list: "To do", title: "t" } });
    await client.callTool({ name: "card_move", arguments: { card: "t", to_list: "Doing" } });
    await client.callTool({ name: "card_update", arguments: { card: "t", desc: "moving along" } });
    const board = loadBoard(dir);
    const doing = board.lists.find((l) => l.title === "Doing")!;
    expect(doing.cards[0].desc).toBe("moving along");
  });

  it("card_done moves to Done with evidence fields", async () => {
    await client.callTool({ name: "card_add", arguments: { list: "Doing", title: "t" } });
    await client.callTool({ name: "card_done", arguments: { card: "t", summary: "shipped" } });
    const board = loadBoard(dir);
    const done = board.lists.find((l) => l.title === "Done")!;
    expect(done.cards[0].done?.summary).toBe("shipped");
    expect(done.cards[0].done?.repoRoot).toBe(dir);
    expect(Array.isArray(done.cards[0].done?.files)).toBe(true);
  });

  it("list ops work end to end", async () => {
    await client.callTool({ name: "list_add", arguments: { title: "Backlog" } });
    await client.callTool({ name: "list_rename", arguments: { list: "Backlog", title: "Icebox" } });
    await client.callTool({ name: "list_delete", arguments: { list: "Icebox" } });
    const board = loadBoard(dir);
    expect(board.lists.map((l) => l.title)).toEqual(["To do", "Doing", "Done"]);
  });

  it("BoardError becomes an isError result, not a crash", async () => {
    const res = (await client.callTool({
      name: "card_delete",
      arguments: { card: "ghost" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });

  it("a corrupt board.json errors and is never overwritten", async () => {
    fs.mkdirSync(path.join(dir, ".maestro"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".maestro", "board.json"), "{broken", "utf8");
    const res = (await client.callTool({
      name: "card_add",
      arguments: { list: "To do", title: "x" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".maestro", "board.json"), "utf8")).toBe("{broken");
  });

  it("fleet_send writes from: null to the outbox when MAESTRO_AGENT is unset", async () => {
    // agentName is captured once at createServer() time, so the pre-existing
    // `client`/`server` from beforeEach already has whatever MAESTRO_AGENT was
    // set when this test process started — spin up a fresh server with the
    // env var cleared first.
    const prevAgent = process.env.MAESTRO_AGENT;
    delete process.env.MAESTRO_AGENT;
    try {
      const [clientTransport2, serverTransport2] = InMemoryTransport.createLinkedPair();
      const server2 = createServer(dir);
      await server2.connect(serverTransport2);
      const client2 = new Client({ name: "test2", version: "0.0.0" });
      await client2.connect(clientTransport2);
      await client2.callTool({ name: "fleet_send", arguments: { message: "hi", to: "Codex #1" } });
      await client2.close();
    } finally {
      if (prevAgent !== undefined) process.env.MAESTRO_AGENT = prevAgent;
    }
    const line = JSON.parse(
      fs.readFileSync(path.join(dir, ".maestro", "outbox.jsonl"), "utf8").trim().split("\n")[0],
    );
    expect(line.from).toBeNull();
    expect(line.to).toBe("Codex #1");
  });

  it("fleet_send threads MAESTRO_AGENT into the outbox as `from`", async () => {
    const prevAgent = process.env.MAESTRO_AGENT;
    process.env.MAESTRO_AGENT = "Claude #1";
    try {
      const [clientTransport2, serverTransport2] = InMemoryTransport.createLinkedPair();
      const server2 = createServer(dir); // agentName is read at createServer() time
      await server2.connect(serverTransport2);
      const client2 = new Client({ name: "test2", version: "0.0.0" });
      await client2.connect(clientTransport2);
      await client2.callTool({ name: "fleet_send", arguments: { message: "go build it" } });
      await client2.close();
    } finally {
      if (prevAgent === undefined) delete process.env.MAESTRO_AGENT;
      else process.env.MAESTRO_AGENT = prevAgent;
    }
    const line = JSON.parse(
      fs.readFileSync(path.join(dir, ".maestro", "outbox.jsonl"), "utf8").trim().split("\n")[0],
    );
    expect(line.from).toBe("Claude #1");
    expect(line.to).toBeNull();
  });
});
