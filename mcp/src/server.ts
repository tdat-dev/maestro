/* MCP surface: nine tools over the board store. Each mutating tool is one
 * load → mutate → save cycle (nothing cached between calls, so a long agent
 * session always sees the Maestro UI's edits). Every error thrown along the
 * way — BoardError or otherwise — is caught and returned as an isError tool
 * result; nothing here propagates to a crash. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadBoard, saveBoard, LABELS, type Board } from "./board.js";
import {
  addCard,
  updateCard,
  moveCard,
  deleteCard,
  markDone,
  addList,
  renameList,
  deleteList,
} from "./ops.js";
import { changedFiles } from "./git.js";
import { readFleet, queueMessage } from "./fleet.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

const labelsSchema = z
  .array(z.string())
  .optional()
  .describe(`Label colour keys: ${LABELS.join("|")}`);

export function createServer(dir: string): McpServer {
  const server = new McpServer({ name: "maestro", version: "0.1.0" });

  // Maestro sets MAESTRO_AGENT=<pane name> on every terminal it spawns, so
  // board mutations can record which agent acted (done.by, claim-on-move).
  const agentName = process.env.MAESTRO_AGENT?.trim() || undefined;

  /** load → mutate → save, mapping any thrown error to an isError tool result. */
  const mutate = (fn: (b: Board) => unknown): ToolResult => {
    try {
      const board = loadBoard(dir);
      const result = fn(board);
      saveBoard(dir, board);
      return ok(result ?? "ok");
    } catch (e) {
      return fail(e);
    }
  };

  server.registerTool(
    "board_get",
    {
      description:
        "Read the Maestro kanban board for this workspace (.maestro/board.json): all lists and their cards, including ids to use with the other tools.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(loadBoard(dir));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "card_add",
    {
      description:
        "Add a card to a list on the Maestro board. `list` is a list id or title (created if the title doesn't exist).",
      inputSchema: {
        list: z.string().describe("List id or title"),
        title: z.string().describe("Card title"),
        desc: z.string().optional().describe("Longer description"),
        labels: labelsSchema,
        due: z.string().optional().describe("Due date, yyyy-mm-dd"),
        checklist: z.array(z.string()).optional().describe("Checklist item texts"),
      },
    },
    async ({ list, title, desc, labels, due, checklist }) =>
      mutate((b) => addCard(b, list, { title, desc, labels, due, checklist })),
  );

  server.registerTool(
    "card_update",
    {
      description:
        "Update fields of a card. `card` is a card id or exact title. Only provided fields change; `checklist` replaces the whole checklist with un-done items.",
      inputSchema: {
        card: z.string().describe("Card id or title"),
        title: z.string().optional(),
        desc: z.string().optional(),
        labels: labelsSchema,
        due: z.string().nullable().optional().describe("yyyy-mm-dd, or null to clear"),
        checklist: z.array(z.string()).optional(),
      },
    },
    async ({ card, ...patch }) => mutate((b) => updateCard(b, card, patch)),
  );

  server.registerTool(
    "card_move",
    {
      description:
        "Move a card to another list (e.g. To do → Doing). `position` is 0-based; omitted = end of the list.",
      inputSchema: {
        card: z.string().describe("Card id or title"),
        to_list: z.string().describe("Target list id or title"),
        position: z.number().int().min(0).optional(),
      },
    },
    async ({ card, to_list, position }) =>
      mutate((b) => moveCard(b, card, to_list, position, agentName)),
  );

  server.registerTool(
    "card_delete",
    {
      description: "Delete a card from the board.",
      inputSchema: { card: z.string().describe("Card id or title") },
    },
    async ({ card }) =>
      mutate((b) => {
        deleteCard(b, card);
        return "deleted";
      }),
  );

  server.registerTool(
    "card_done",
    {
      description:
        "Mark a task finished: move the card to the Done list and attach evidence (summary + files currently changed in git).",
      inputSchema: {
        card: z.string().describe("Card id or title"),
        summary: z.string().optional().describe("One line on what changed"),
      },
    },
    async ({ card, summary }) =>
      mutate((b) =>
        markDone(b, card, { repoRoot: dir, files: changedFiles(dir), summary, by: agentName }),
      ),
  );

  server.registerTool(
    "list_add",
    {
      description: "Add a new empty list to the board.",
      inputSchema: { title: z.string() },
    },
    async ({ title }) => mutate((b) => addList(b, title)),
  );

  server.registerTool(
    "list_rename",
    {
      description: "Rename a list.",
      inputSchema: {
        list: z.string().describe("List id or current title"),
        title: z.string().describe("New title"),
      },
    },
    async ({ list, title }) => mutate((b) => renameList(b, list, title)),
  );

  server.registerTool(
    "list_delete",
    {
      description: "Delete a list and all its cards.",
      inputSchema: { list: z.string().describe("List id or title") },
    },
    async ({ list }) =>
      mutate((b) => {
        deleteList(b, list);
        return "deleted";
      }),
  );

  server.registerTool(
    "fleet_status",
    {
      description:
        "List the other agents Maestro is running in this workspace and their live status (needs = waiting on the user, active = working, idle, stopped). Use to coordinate — e.g. see who is free before handing off work.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(readFleet(dir));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "fleet_send",
    {
      description:
        "Send a message to another agent in this workspace (or the whole fleet). Maestro types it into the target agent's terminal. Use to hand off a task or coordinate. Omit `to` to broadcast to every agent.",
      inputSchema: {
        message: z.string().describe("The text to deliver"),
        to: z
          .string()
          .optional()
          .describe("Target agent name (from fleet_status). Omit to broadcast to all agents."),
      },
    },
    async ({ message, to }) => {
      try {
        const m = queueMessage(dir, { from: agentName, to, message, now: Date.now() });
        return ok(m.to ? `sent to ${m.to}` : "broadcast to the fleet");
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
