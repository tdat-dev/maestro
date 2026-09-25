/* Browser tools for maestro-mcp: the agent's side of "Maestro for Chrome".
 *
 * Calls go over one WebSocket to the hub inside the Maestro app (port and
 * token in ~/.maestro/browser-hub.json). The hub routes each call to the
 * browser this agent picked, where the extension runs it in the agent's own
 * tab group. Results come back already MCP-shaped ({ content: [...] }). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean; gif?: string };

export function hubFile(): string {
  return path.join(os.homedir(), ".maestro", "browser-hub.json");
}

const CALL_TIMEOUT_MS = 90_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** How long a click held for the user's OK may wait. */
const HOLD_TIMEOUT_MS = 10 * 60_000;

export class HubClient {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private next = 1;
  private waiting = new Map<number, { resolve: (r: ToolResult) => void; timer: NodeJS.Timeout; tool: string }>();

  constructor(
    private agent: string,
    private readHub: () => { port: number; token: string } = () => JSON.parse(fs.readFileSync(hubFile(), "utf8")),
  ) {}

  private open(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let hub: { port: number; token: string };
      try {
        hub = this.readHub();
      } catch {
        return reject(new Error("Maestro isn't running, so there is no browser to use. Open Maestro and try again."));
      }
      if (typeof WebSocket === "undefined") return reject(new Error("Browser tools need Node 22 or newer."));
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/`);
      const slow = setTimeout(() => {
        ws.close();
        drop("Maestro did not answer.");
        reject(new Error("Maestro did not answer. Is it open?"));
      }, CONNECT_TIMEOUT_MS);
      const drop = (why: string) => {
        this.ws = null;
        this.ready = null;
        for (const [, w] of this.waiting) {
          clearTimeout(w.timer);
          w.resolve(err(why));
        }
        this.waiting.clear();
      };
      ws.addEventListener("open", () => {
        clearTimeout(slow);
        ws.send(JSON.stringify({ type: "hello", role: "agent", token: hub.token, agent: this.agent }));
        this.ws = ws;
        resolve();
      });
      ws.addEventListener("message", (e) => this.onMessage(String(e.data)));
      ws.addEventListener("error", () => {
        clearTimeout(slow);
        drop("Lost the connection to Maestro.");
        reject(new Error("Can't reach Maestro. Is it open?"));
      });
      ws.addEventListener("close", () => drop("Maestro closed the connection."));
    });
    return this.ready;
  }

  private onMessage(raw: string) {
    let m: { type?: string; id?: number; result?: ToolResult; error?: string };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof m.id !== "number") return;
    const w = this.waiting.get(m.id);
    if (!w) return;
    if (m.type === "hold") {
      // Maestro is asking the user first: wait for their answer, not the usual limit.
      clearTimeout(w.timer);
      const id = m.id;
      w.timer = setTimeout(() => {
        this.waiting.delete(id);
        w.resolve(err("The user did not answer in time, so it was not done."));
      }, HOLD_TIMEOUT_MS);
      return;
    }
    this.waiting.delete(m.id);
    clearTimeout(w.timer);
    // Only the MCP fields: the browser adds its own notes for Maestro.
    if (m.type === "result" && m.result?.content)
      w.resolve({ content: m.result.content, ...(m.result.isError ? { isError: true } : {}), ...(m.result.gif ? { gif: m.result.gif } : {}) });
    else w.resolve(err(m.error ?? "The browser did not answer."));
  }

  async call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      await this.open();
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
    const id = this.next++;
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(err(`The browser took longer than ${CALL_TIMEOUT_MS / 1000}s on ${tool}.`));
      }, CALL_TIMEOUT_MS);
      this.waiting.set(id, { resolve, timer, tool });
      this.ws!.send(JSON.stringify({ type: "call", id, tool, args }));
    });
  }
}

const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const tabId = z.number().int().optional().describe("Tab id from browser_tabs; defaults to your most recent tab");

export const BROWSER_INSTRUCTIONS = `Browser: you can use the user's real Chrome (their logins included) through the browser_* tools. You work in your own tab group, named after you. Reuse your tab: browser_navigate goes to a page in it (and opens it the first time); open another with browser_tab_new only when you need two pages side by side, and close tabs you are done with. Read a page with browser_read_page (gives refs), act with browser_computer (click a ref or a screenshot coordinate, type, key), and check with a screenshot. When you hit a login page or a CAPTCHA, stop and ask the user to handle it. Never submit payments or send messages the user didn't ask for. Clicks that send, post, pay or delete wait for the user to allow them in Maestro; if they say no, don't retry.`;

/** Absolute paths for files to upload: relative ones are taken from the
 *  workspace; every file must exist, so the page never gets a bad path. */
export function uploadPaths(paths: string[], base: string): string[] {
  return paths.map((p) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(base, p);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`No such file: ${abs}`);
    return abs;
  });
}

/** Where a recording is saved when the agent names no path. */
export function gifPath(base: string, agent: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(base, ".maestro", "recordings", `${agent.replace(/[^\w-]+/g, "_")}-${stamp}.gif`);
}

export function registerBrowserTools(server: McpServer, hub: HubClient, base = process.cwd(), agent = "Agent") {
  const tool = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, hubTool: string) =>
    server.registerTool(name, { description, inputSchema }, async (args: Record<string, unknown>) => hub.call(hubTool, args) as never);

  tool("browser_list", "List the browsers (Chrome/Edge/Brave profiles) connected to Maestro. The one marked * is the one you use.", {}, "list_browsers");
  tool(
    "browser_select",
    "Choose which connected browser profile you use, by profile name, email or id from browser_list.",
    { browser: z.string().describe("Profile name, email, or id") },
    "select_browser",
  );
  tool(
    "browser_tabs",
    "Your tabs in the browser (your tab group). With all=true, also every other open tab, which you can take with browser_tab_adopt.",
    { all: z.boolean().optional() },
    "tabs",
  );
  tool(
    "browser_tab_new",
    "Open another tab in your tab group, optionally at a URL. Only when you need a second page next to the one you have; to go somewhere else, use browser_navigate in your current tab.",
    { url: z.string().optional() },
    "tab_new",
  );
  tool("browser_tab_adopt", "Move one of the user's tabs into your tab group so you can work in it. Only when the user asked you to.", { tabId: z.number().int() }, "tab_adopt");
  tool("browser_tab_close", "Close one of your tabs.", { tabId }, "tab_close");
  tool(
    "browser_navigate",
    'Go to a URL in your current tab (opening your first tab if you have none), or "back", "forward", "reload". Waits for the page to load.',
    { url: z.string(), tabId },
    "navigate",
  );
  tool(
    "browser_read_page",
    "Outline of the page: its interactive elements (or with filter=all, headings and images too), each with a ref to use in browser_computer / browser_form_input, and its position.",
    { tabId, filter: z.enum(["interactive", "all"]).optional(), max: z.number().int().optional() },
    "read_page",
  );
  tool(
    "browser_find",
    "Find elements whose text or label contains all the words of a query. Returns refs.",
    { query: z.string(), tabId },
    "find",
  );
  tool(
    "browser_page_text",
    "The page's visible text, for reading articles, results or tables.",
    { tabId, max: z.number().int().optional().describe("Character limit, default 40000") },
    "page_text",
  );
  tool(
    "browser_form_input",
    "Set a form field (text, textarea, select, checkbox) by ref, the way typing would.",
    { ref: z.string(), value: z.union([z.string(), z.boolean(), z.number()]), tabId },
    "form_input",
  );
  tool(
    "browser_computer",
    "Real mouse and keyboard in your tab. Actions: screenshot, left_click, right_click, double_click, triple_click, hover, scroll, type (text), key (e.g. \"Enter\", \"ctrl+a\"), wait (duration seconds). Target with ref (from browser_read_page) or coordinate [x, y] (from a screenshot).",
    {
      action: z.enum(["screenshot", "left_click", "right_click", "double_click", "triple_click", "hover", "scroll", "type", "key", "wait"]),
      ref: z.string().optional(),
      coordinate: z.array(z.number()).length(2).optional(),
      text: z.string().optional(),
      scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
      scroll_amount: z.number().optional(),
      duration: z.number().optional(),
      tabId,
    },
    "computer",
  );
  tool(
    "browser_javascript",
    "Run JavaScript in the page and get the value of its last expression (await allowed).",
    { code: z.string(), tabId },
    "javascript",
  );
  tool(
    "browser_console",
    "Console messages from your tab since Maestro started controlling it. Filter with a regex pattern.",
    { pattern: z.string().optional(), onlyErrors: z.boolean().optional(), limit: z.number().int().optional(), clear: z.boolean().optional(), tabId },
    "console",
  );
  tool(
    "browser_network",
    "Network requests from your tab since Maestro started controlling it. Filter URLs with a regex pattern.",
    { pattern: z.string().optional(), limit: z.number().int().optional(), clear: z.boolean().optional(), tabId },
    "network",
  );
  server.registerTool(
    "browser_file_upload",
    {
      description: "Attach files from this computer to a file field on the page. ref is the file field, or the button that opens the file chooser. Paths may be relative to the workspace.",
      inputSchema: { ref: z.string(), paths: z.array(z.string()).min(1), tabId },
    },
    async (args) => {
      try {
        return (await hub.call("upload", { ...args, paths: uploadPaths(args.paths, base) })) as never;
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e)) as never;
      }
    },
  );
  tool(
    "browser_resize",
    "Resize the Chrome window your tab is in (it is the user's window too; only when a page must be seen at a size, and say so).",
    { width: z.number().int(), height: z.number().int(), tabId },
    "resize",
  );
  server.registerTool(
    "browser_gif",
    {
      description: "Record what you do in your tab as an animated GIF: action start, do the steps, then action stop. The GIF is saved to a file (path, or .maestro/recordings/ in the workspace). It shows logged-in pages, so tell the user before sharing it.",
      inputSchema: { action: z.enum(["start", "stop"]), path: z.string().optional(), tabId },
    },
    async ({ action, path: out, tabId: tab }) => {
      const r = await hub.call("gif", { action, tabId: tab });
      if (action !== "stop" || r.isError || !r.gif) return { content: r.content, ...(r.isError ? { isError: true } : {}) } as never;
      const file = out ? (path.isAbsolute(out) ? out : path.resolve(base, out)) : gifPath(base, agent);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.gif, "base64"));
      const kb = Math.round(fs.statSync(file).size / 1024);
      return { content: [...r.content, { type: "text", text: `Saved ${file} (${kb} KB).` }] } as never;
    },
  );
  tool(
    "browser_dialog",
    "Accept or dismiss an alert/confirm/prompt dialog that is blocking your tab.",
    { accept: z.boolean(), text: z.string().optional().describe("Answer for a prompt()"), tabId },
    "dialog",
  );
}
