#!/usr/bin/env node
/* maestro-mcp entry: stdio MCP server for the Maestro kanban board.
 * Workspace resolution, most-specific first:
 *   1. argv[2]            — explicit override (`maestro-mcp <dir>`)
 *   2. MAESTRO_WORKSPACE  — the workspace folder Maestro spawned the agent in;
 *      set on every Maestro-spawned terminal. Pins the board to that workspace
 *      even if the agent's cwd drifts (a `cd`, a subdir, a git worktree), so an
 *      agent can never write its cards into a DIFFERENT project's board.
 *   3. process.cwd()      — fallback for agents launched outside Maestro. */

import fs from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const dir = path.resolve(
  process.argv[2] ?? (process.env.MAESTRO_WORKSPACE?.trim() || process.cwd()),
);
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`maestro-mcp: workspace directory not found: ${dir}`);
  process.exit(1);
}

const server = createServer(dir);
await server.connect(new StdioServerTransport());
