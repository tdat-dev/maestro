/* App side of the fleet file-bridge (maestro-mcp is the other side).
 *
 *  - Publishes each workspace's live agent roster to <dir>/.maestro/fleet.json
 *    so an agent can call the MCP `fleet_status` tool and see who else is here.
 *  - Watches <dir>/.maestro/outbox.jsonl, where the MCP `fleet_send` tool
 *    appends messages, and delivers each new line into the target agent's PTY.
 *
 * The pure helpers (serialize/parse) are DOM- and IPC-free for unit tests; the
 * init function owns the timer and the fs calls. */

import { fsReadFile, fsWriteFile, fsStat, fsCreateDir, fsCreateFile } from "./ipc";

const MAESTRO_DIR = ".maestro";
const FLEET_REL = ".maestro\\fleet.json";
const OUTBOX_REL = ".maestro\\outbox.jsonl";
const SPAWN_REL = ".maestro\\spawn-requests.jsonl";

export interface BridgeAgent {
  id: string;
  name: string;
  status: "needs" | "active" | "idle" | "stopped";
  screen?: string; // recent on-screen text, for the MCP agent_output tool
}
export interface BridgeWorkspace {
  dir: string;
  name: string;
  agents: BridgeAgent[];
}

/** The roster JSON the MCP `fleet_status` / `agent_output` tools read. */
export function serializeFleet(ws: BridgeWorkspace): string {
  return JSON.stringify({
    agents: ws.agents.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      workspace: ws.name,
      screen: a.screen ?? "",
    })),
  });
}

export interface OutboxLine {
  to: string | null;
  message: string;
}

/** Parse one outbox jsonl line to a deliverable message, or null if unusable. */
export function parseOutboxLine(line: string): OutboxLine | null {
  const t = line.trim();
  if (!t) return null;
  let o: unknown;
  try {
    o = JSON.parse(t);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.message !== "string" || !r.message.trim()) return null;
  return { to: typeof r.to === "string" && r.to.trim() ? r.to : null, message: r.message };
}

export interface SpawnLine {
  cli: string;
  task: string | null;
  count: number;
}

/** Parse one spawn-request jsonl line, or null if unusable. */
export function parseSpawnLine(line: string): SpawnLine | null {
  const t = line.trim();
  if (!t) return null;
  let o: unknown;
  try {
    o = JSON.parse(t);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.cli !== "string" || !r.cli.trim()) return null;
  const count = typeof r.count === "number" ? Math.max(1, Math.min(r.count, 6)) : 1;
  return { cli: r.cli, task: typeof r.task === "string" && r.task.trim() ? r.task : null, count };
}

export interface FleetBridgeHost {
  /** Every workspace that has a folder, with its current agents. */
  workspaces(): BridgeWorkspace[];
  /** Deliver a message into a workspace's agent(s): `to` name, or null = all. */
  deliver(dir: string, to: string | null, message: string): void;
  /** Spawn worker agent(s) an agent requested (conductor grows its crew). */
  spawn(dir: string, req: SpawnLine): void;
}

// Per-dir count of outbox lines already delivered. First sight of a workspace
// records the current length so a restart doesn't replay the whole backlog.
const consumed = new Map<string, number>();
const spawnConsumed = new Map<string, number>();
// Per-dir last fleet.json we wrote, to skip no-op writes (status unchanged).
const lastFleet = new Map<string, string>();

async function ensureMaestro(dir: string): Promise<void> {
  try {
    await fsCreateDir(dir, MAESTRO_DIR);
  } catch {
    /* exists */
  }
}

/** Start the publish + deliver loop. Returns a stop function. */
export function initFleetBridge(host: FleetBridgeHost, intervalMs = 1500): () => void {
  const timer = window.setInterval(() => {
    for (const ws of host.workspaces()) {
      if (!ws.dir) continue;
      void publishRoster(ws);
      void drainOutbox(ws.dir, host);
      void drainSpawns(ws.dir, host);
    }
  }, intervalMs);
  return () => window.clearInterval(timer);
}

async function publishRoster(ws: BridgeWorkspace): Promise<void> {
  const content = serializeFleet(ws);
  if (lastFleet.get(ws.dir) === content) return; // nothing changed
  try {
    await ensureMaestro(ws.dir);
    try {
      await fsCreateFile(ws.dir, FLEET_REL);
    } catch {
      /* exists */
    }
    await fsWriteFile(ws.dir, FLEET_REL, content, null);
    lastFleet.set(ws.dir, content);
  } catch {
    /* folder unwritable this tick — try again next time */
  }
}

async function drainOutbox(dir: string, host: FleetBridgeHost): Promise<void> {
  let content: string;
  try {
    await fsStat(dir, OUTBOX_REL); // cheap existence probe
    content = (await fsReadFile(dir, OUTBOX_REL)).content;
  } catch {
    return; // no outbox yet
  }
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const seen = consumed.get(dir);
  if (seen === undefined) {
    consumed.set(dir, lines.length); // skip backlog on first sight
    return;
  }
  for (let i = seen; i < lines.length; i += 1) {
    const parsed = parseOutboxLine(lines[i]);
    if (parsed) host.deliver(dir, parsed.to, parsed.message);
  }
  consumed.set(dir, lines.length);
}

async function drainSpawns(dir: string, host: FleetBridgeHost): Promise<void> {
  let content: string;
  try {
    await fsStat(dir, SPAWN_REL);
    content = (await fsReadFile(dir, SPAWN_REL)).content;
  } catch {
    return; // no spawn requests yet
  }
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const seen = spawnConsumed.get(dir);
  if (seen === undefined) {
    spawnConsumed.set(dir, lines.length); // skip backlog on first sight
    return;
  }
  for (let i = seen; i < lines.length; i += 1) {
    const parsed = parseSpawnLine(lines[i]);
    if (parsed) host.spawn(dir, parsed);
  }
  spawnConsumed.set(dir, lines.length);
}
