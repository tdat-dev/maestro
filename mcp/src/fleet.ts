/* Fleet bridge for maestro-mcp: read the roster the Maestro app publishes to
 * <workspace>/.maestro/fleet.json, and hand messages to the app by appending
 * to <workspace>/.maestro/outbox.jsonl. Same file-bridge idea as the board —
 * the MCP server never talks to the app directly, only through files it
 * watches. Pure of any MCP wiring so it can be unit-tested. */

import fs from "node:fs";
import path from "node:path";

export interface FleetAgent {
  id: string;
  name: string;
  status: "needs" | "active" | "idle" | "stopped";
  workspace: string;
  screen: string; // recent on-screen text (for agent_output)
}

export interface OutboxMessage {
  ts: number;
  from: string; // MAESTRO_AGENT of the sender, or "agent"
  to: string | null; // target agent name, or null for the whole fleet
  message: string;
}

export function fleetPath(dir: string): string {
  return path.join(dir, ".maestro", "fleet.json");
}
export function outboxPath(dir: string): string {
  return path.join(dir, ".maestro", "outbox.jsonl");
}
export function spawnPath(dir: string): string {
  return path.join(dir, ".maestro", "spawn-requests.jsonl");
}

export interface SpawnRequest {
  ts: number;
  from: string;
  cli: string; // e.g. "claude", "codex", "gemini", or a raw command
  task: string | null; // optional prompt typed into the new agent
  count: number;
}

/** Ask Maestro to spawn worker agent(s). Appends a request the app watches. */
export function queueSpawn(
  dir: string,
  req: { from?: string; cli: string; task?: string | null; count?: number; now: number },
): SpawnRequest {
  const cli = req.cli.trim();
  if (!cli) throw new Error("cli must not be empty");
  const entry: SpawnRequest = {
    ts: req.now,
    from: req.from?.trim() || "agent",
    cli,
    task: req.task?.trim() || null,
    count: Math.max(1, Math.min(req.count ?? 1, 6)),
  };
  const p = spawnPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/** Read the roster the app last published. [] when the app hasn't written it
 *  yet (no file) or it's momentarily unreadable — never throws. */
export function readFleet(dir: string): FleetAgent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(fleetPath(dir), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray((parsed as { agents?: unknown })?.agents)
    ? (parsed as { agents: unknown[] }).agents
    : Array.isArray(parsed)
      ? (parsed as unknown[])
      : [];
  const out: FleetAgent[] = [];
  for (const a of arr) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    const status = o.status;
    out.push({
      id: typeof o.id === "string" ? o.id : "",
      name: o.name,
      status:
        status === "needs" || status === "active" || status === "idle" || status === "stopped"
          ? status
          : "idle",
      workspace: typeof o.workspace === "string" ? o.workspace : "",
      screen: typeof o.screen === "string" ? o.screen : "",
    });
  }
  return out;
}

/** The recent on-screen text of one agent by name (case-insensitive), or null
 *  if there's no such agent. For the MCP agent_output tool. */
export function readAgentScreen(dir: string, name: string): string | null {
  const want = name.trim().toLowerCase();
  const a = readFleet(dir).find((x) => x.name.trim().toLowerCase() === want);
  return a ? a.screen : null;
}

/** Append one message to the outbox for the app to deliver. Creates .maestro/
 *  and the file on first use. Returns the message that was queued. */
export function queueMessage(
  dir: string,
  msg: { from?: string; to?: string | null; message: string; now: number },
): OutboxMessage {
  const text = msg.message.trim();
  if (!text) throw new Error("message must not be empty");
  const entry: OutboxMessage = {
    ts: msg.now,
    from: msg.from?.trim() || "agent",
    to: msg.to?.trim() || null,
    message: text,
  };
  const p = outboxPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}
