#!/usr/bin/env node
/* maestro-mcp entry: stdio MCP server for the Maestro kanban board.
 * Workspace = argv[2] if given, else cwd (Claude Code spawns stdio servers
 * with cwd = the project root, so a user-scoped install needs no args). */

import fs from "node:fs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const dir = path.resolve(process.argv[2] ?? process.cwd());
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`maestro-mcp: workspace directory not found: ${dir}`);
  process.exit(1);
}

const server = createServer(dir);
await server.connect(new StdioServerTransport());
