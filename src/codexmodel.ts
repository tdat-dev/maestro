// Turns a Codex rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) into
// the same conversation the chat view draws for Claude Code: your messages,
// its replies, the steps it took with their results, and what the side panel
// needs (model, effort, approval policy, files, background commands). Pure:
// feed it lines, read `items` and `meta`. No DOM here.

import {
  baseName, fileLedger, newMeta, taskLedger,
  type Chat, type ChatImage, type ChatItem, type DiffLine, type StepItem, type Todo,
} from "./chatmodel";

type Input = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const MAX_OUTPUT = 6000;
const MAX_DIFF_LINES = 400;
const MAX_IMAGES = 8;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function firstLine(s: string, max = 120): string {
  const line = s.trim().split(/\r?\n/)[0] ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function trimOutput(s: string): string {
  const t = s.replace(/\s+$/, "");
  return t.length > MAX_OUTPUT ? t.slice(0, MAX_OUTPUT) + "\n…" : t;
}

/** A picture from a data: URL, as the chat keeps pictures. */
function pictureOf(url: string): ChatImage | null {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (!m || !IMAGE_TYPES.has(m[1].toLowerCase())) return null;
  return { media: m[1].toLowerCase(), data: m[2] };
}

/** Context Codex puts in a user message that you did not type. */
const INJECTED = /^\s*(<(environment_context|user_instructions|recommended_plugins|subagent_notification|turn_aborted|app-context|permissions|collaboration_mode|user_shell_command|INSTRUCTIONS)\b|<\/?image\b|# AGENTS\.md instructions)/i;

/** What you typed, out of a user message's parts (and the pictures you pasted). */
export function userWords(content: unknown): { text: string; pics: ChatImage[] } {
  const parts = Array.isArray(content) ? (content as Input[]) : [];
  const words: string[] = [];
  const pics: ChatImage[] = [];
  for (const c of parts) {
    if (c.type === "input_image") {
      const p = pictureOf(str(c.image_url));
      if (p) pics.push(p);
      continue;
    }
    if (c.type !== "input_text" && c.type !== "text") continue;
    let t = str(c.text);
    if (INJECTED.test(t)) continue;
    // The IDE and pasted files come first; your words follow "## My request…:".
    if (/^\s*# (Context from my IDE setup|Files mentioned by the user)/.test(t)) {
      const m = /## My request[^\n]*:[ \t]*\r?\n([\s\S]*)$/.exec(t);
      if (!m) continue;
      t = m[1];
    }
    t = t.trim();
    if (t) words.push(t);
  }
  return { text: words.join("\n"), pics: pics.slice(-MAX_IMAGES) };
}

/** One file in an apply_patch: what happened to it and its lines. */
export interface PatchFile { path: string; kind: "add" | "update" | "delete"; diff: DiffLine[]; added: number; removed: number }

/** Codex's patch format ("*** Begin Patch", "*** Add File: …", "@@", ±lines) per file. */
export function parsePatch(input: string): PatchFile[] {
  const out: PatchFile[] = [];
  let cur: PatchFile | null = null;
  for (const raw of input.split(/\r?\n/)) {
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(raw);
    if (head) {
      cur = { path: head[2].trim(), kind: head[1] === "Add" ? "add" : head[1] === "Delete" ? "delete" : "update", diff: [], added: 0, removed: 0 };
      out.push(cur);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(raw);
    if (move && cur) { cur.path = move[1].trim(); continue; }
    if (!cur || raw.startsWith("***")) continue;
    if (raw.startsWith("@@")) {
      if (cur.diff.length && cur.diff.length < MAX_DIFF_LINES) cur.diff.push({ sign: " ", text: "⋯" });
      continue;
    }
    const sign = raw[0];
    if (sign === "+") { cur.added++; if (cur.diff.length < MAX_DIFF_LINES) cur.diff.push({ sign: "+", text: raw.slice(1) }); }
    else if (sign === "-") { cur.removed++; if (cur.diff.length < MAX_DIFF_LINES) cur.diff.push({ sign: "-", text: raw.slice(1) }); }
    else if (sign === " " && cur.diff.length < MAX_DIFF_LINES) cur.diff.push({ sign: " ", text: raw.slice(1) });
  }
  return out;
}

function parseArgs(v: unknown): Input {
  if (v && typeof v === "object") return v as Input;
  try { const o = JSON.parse(str(v)); return o && typeof o === "object" ? (o as Input) : {}; } catch { return {}; }
}

/** A JS string literal's value ("…", '…' or `…`). */
function literal(s: string): string {
  if (s.startsWith('"')) { try { return JSON.parse(s) as string; } catch { /* fall through */ } }
  return s.slice(1, -1).replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n");
}

/** What a JS cell does: the tools it calls, the commands it runs, a patch it applies. */
export function cellInfo(code: string): { tools: string[]; commands: string[]; patch: string | null } {
  const tools = [...new Set([...code.matchAll(/\btools\.(\w+)\s*\(/g)].map((m) => m[1]))];
  const commands = [...code.matchAll(/\b(?:cmd|command)["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g)].map((m) => literal(m[1]));
  const a = code.indexOf("*** Begin Patch");
  const b = a < 0 ? -1 : code.indexOf("*** End Patch", a);
  let patch = a < 0 || b < 0 ? null : code.slice(a, b + "*** End Patch".length);
  // A patch inside a JSON string keeps its line breaks escaped.
  if (patch && !patch.includes("\n") && patch.includes("\\n")) patch = patch.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return { tools, commands, patch };
}

type Described = Omit<StepItem, "kind" | "id" | "done" | "at">;

/** How a Codex tool call reads in the chat: a verb and what it touched. */
export function describeCodexTool(name: string, input: unknown, namespace = ""): Described {
  const a = parseArgs(input);
  switch (name) {
    case "shell_command":
    case "exec_command": {
      const cmd = str(a.command) || str(a.cmd);
      return { tool: name, verb: "Ran", target: firstLine(cmd), full: cmd, code: true };
    }
    case "shell":
    case "local_shell": {
      const argv = Array.isArray(a.command) ? (a.command as unknown[]).map(str) : [str(a.command)];
      // ["powershell.exe", "-Command", "…"] / ["bash", "-lc", "…"]: the script is the last part.
      const cmd = argv.length > 2 && /^-(c|lc|Command)$/i.test(argv[argv.length - 2]) ? argv[argv.length - 1] : argv.join(" ");
      return { tool: name, verb: "Ran", target: firstLine(cmd), full: cmd, code: true };
    }
    case "exec":
    case "functions__exec":
    case "js": {
      const code = typeof input === "string" ? input : str(a.code) || str(a.input);
      const cell = cellInfo(code);
      if (cell.commands.length) {
        const more = cell.commands.length > 1 ? ` (+${cell.commands.length - 1} more)` : "";
        return { tool: name, verb: "Ran", target: firstLine(cell.commands[0]) + more, full: cell.commands.join("\n"), code: true };
      }
      if (cell.tools.includes("update_plan")) return { tool: name, verb: "Updated the plan", target: "" };
      if (cell.tools.includes("view_image")) {
        const p = /path\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(code);
        const file = p ? literal(p[1]) : "";
        return { tool: name, verb: "Looked at", target: file ? baseName(file) : "an image", full: file || undefined, code: !!file };
      }
      return { tool: name, verb: "Ran a script", target: firstLine(code, 80), full: code, code: true };
    }
    case "write_stdin":
      return { tool: name, verb: "Checked on", target: `the command running as session ${str(a.session_id) || String(a.session_id ?? "")}`.trim() };
    case "wait":
      return { tool: name, verb: "Waited for", target: "a running script" };
    case "update_plan": {
      const todos: Todo[] = (Array.isArray(a.plan) ? (a.plan as Input[]) : []).map((t) => ({
        text: str(t.step),
        state: (["pending", "in_progress", "completed"].includes(str(t.status)) ? str(t.status) : "pending") as Todo["state"],
      }));
      return { tool: name, verb: "Updated the plan", target: `${todos.filter((t) => t.state === "completed").length} of ${todos.length} done`, todos };
    }
    case "view_image": {
      const p = str(a.path);
      return { tool: name, verb: "Looked at", target: baseName(p), full: p, code: true };
    }
    case "spawn_agent":
    case "spawn_agents":
      return { tool: name, verb: "Asked a helper agent to", target: str(a.task_name) || str(a.nickname) || "help" };
    case "wait_agent":
    case "send_message":
    case "send_input":
    case "list_agents":
    case "close_agent":
    case "interrupt_agent":
    case "followup_task":
      return { tool: name, verb: "Talked to", target: "its helper agents" };
    case "request_user_input":
      return { tool: name, verb: "Asked you", target: firstLine(str(a.question) || str(a.prompt) || "a question") };
    case "tool_search":
      return { tool: name, verb: "Loaded tools", target: firstLine(str(a.query), 60) };
  }
  const where = namespace.replace(/^mcp__|__$/g, "").replace(/[_-]+/g, " ").trim();
  return { tool: name, verb: "Used", target: where ? `${where} · ${name.replace(/_/g, " ")}` : name.replace(/_/g, " ") };
}

/** A tool result's text and pictures, from a string, a JSON envelope or content parts. */
function resultOf(output: unknown): { text: string; pics: ChatImage[]; exit: number | null; running: string | null } {
  let text = "";
  const pics: ChatImage[] = [];
  let exit: number | null = null;
  if (Array.isArray(output)) {
    for (const c of output as Input[]) {
      if (c.type === "input_image") { const p = pictureOf(str(c.image_url)); if (p) pics.push(p); }
      else if (typeof c.text === "string") text += (text ? "\n" : "") + c.text;
    }
  } else {
    text = str(output);
    if (/^\s*\{/.test(text)) {
      // apply_patch answers {"output": "...", "metadata": {"exit_code": 0}}
      try {
        const o = JSON.parse(text) as Input;
        if (typeof o.output === "string") {
          text = o.output;
          const md = (o.metadata ?? {}) as Input;
          if (typeof md.exit_code === "number") exit = md.exit_code;
        }
      } catch { /* plain text */ }
    }
  }
  // A cell's exit codes: any failing command makes the step a failure.
  for (const m of text.matchAll(/(?:Process exited with code|^Exit code:)\s*(-?\d+)/gm)) {
    const c = Number(m[1]);
    if (exit === null || c !== 0) exit = c;
  }
  if (exit === null && /^Script error:/m.test(text)) exit = 1;
  // "Process running with session ID 43354": a command still going on its own.
  const running = /Process running with session ID (\d+)/.exec(text)?.[1] ?? null;
  // The headers Codex puts around command output (a cell nests one per command): keep what was printed.
  text = text
    .split(/\r?\n/)
    .filter((l) => !HEADER.test(l))
    .join("\n")
    .replace(/^\s*\n/, "");
  return { text, pics: pics.slice(-MAX_IMAGES), exit, running };
}

const HEADER = /^(Script completed|Script running.*|Chunk ID: \S+|Wall time:? [\d.]+ seconds|Exit code: -?\d+|Process exited with code -?\d+|Process running with session ID \d+|Original token count: \d+|Output:)\s*$/;

export function createCodexChat(): Chat {
  const items: ChatItem[] = [];
  const meta = newMeta();
  const noteFile = fileLedger(meta);
  const noteTask = taskLedger(meta);
  /** Steps waiting for their output, by call id (a patch makes one step per file). */
  const calls = new Map<string, { steps: StepItem[]; name: string; session: string }>();
  let outputTokens = 0;
  let n = 0;
  const id = () => `x${n++}`;

  /** Model, effort and approval policy, from turn_context or thread_settings_applied. */
  function settings(s: Input): void {
    if (typeof s.model === "string" && s.model) meta.model = s.model;
    const collab = (s.collaboration_mode ?? {}) as Input;
    const inCollab = (collab.settings ?? {}) as Input;
    const effort = str(s.effort) || str(s.reasoning_effort) || str(inCollab.reasoning_effort);
    if (effort) meta.effort = effort;
    const approval = str(s.approval_policy);
    if (str(collab.mode) === "plan") meta.permission = "plan";
    else if (approval) meta.permission = approval;
  }

  function onUser(content: unknown, at: number): void {
    const { text, pics } = userWords(content);
    if (!text && !pics.length) return;
    meta.turn++;
    items.push({ kind: "user", id: id(), text, images: pics.length, ...(pics.length ? { pics } : {}), at });
  }

  function onAssistant(content: unknown, at: number): void {
    for (const c of Array.isArray(content) ? (content as Input[]) : []) {
      const text = str(c.text).trim();
      if ((c.type === "output_text" || c.type === "text") && text) items.push({ kind: "text", id: id(), text, at });
    }
  }

  function onCall(p: Input, at: number): void {
    const callId = str(p.call_id);
    const name = str(p.name);
    const input = p.type === "custom_tool_call" ? p.input : p.arguments;
    const steps: StepItem[] = [];
    // A JS cell may apply a patch itself (tools.apply_patch(`*** Begin Patch…`)).
    const cellPatch = /^(exec|functions__exec|js)$/.test(name) && typeof input === "string" && input.includes("apply_patch") ? cellInfo(input).patch : null;
    if (name === "apply_patch" || cellPatch) {
      const patch = cellPatch ?? (typeof input === "string" ? input : str(parseArgs(input).input) || str(parseArgs(input).patch));
      for (const f of parsePatch(patch)) {
        const verb = f.kind === "add" ? "Wrote" : f.kind === "delete" ? "Deleted" : "Edited";
        const step: StepItem = { kind: "step", id: id(), tool: name, verb, target: baseName(f.path), full: f.path, code: true, diff: f.diff, added: f.added, removed: f.removed, done: false, at };
        steps.push(step);
        noteFile({ path: f.path, added: f.added, removed: f.removed, isNew: f.kind === "add", deleted: f.kind === "delete" ? true : undefined, step: step.id, at });
      }
      if (!steps.length) steps.push({ kind: "step", id: id(), tool: name, verb: "Edited", target: "files", done: false, at });
    } else {
      const step: StepItem = { kind: "step", id: id(), done: false, at, ...describeCodexTool(name, input, str(p.namespace)) };
      if (step.todos) meta.todos = step.todos;
      steps.push(step);
    }
    for (const s of steps) items.push(s);
    const args = parseArgs(input);
    const session = name === "write_stdin" ? String(args.session_id ?? "") : "";
    if (callId) calls.set(callId, { steps, name, session });
  }

  function onOutput(p: Input, at: number): void {
    const call = calls.get(str(p.call_id));
    if (!call) return;
    const { text, pics, exit, running } = resultOf(p.output);
    const failed = (exit !== null && exit !== 0) || /^(apply_patch verification failed|error:|write_stdin failed)/i.test(text.trim());
    for (const s of call.steps) {
      s.output = trimOutput(text);
      if (pics.length) s.images = pics;
      s.error = failed;
      s.done = true;
    }
    // A command still going on its own is a background task until it exits.
    const first = call.steps[0];
    if (running && call.name !== "write_stdin") {
      noteTask({ id: `s${running}`, label: first.target, command: first.full, state: "running", at });
    } else if (call.session) {
      if (running) noteTask({ id: `s${call.session}`, state: "running" });
      else if (exit !== null) noteTask({ id: `s${call.session}`, state: exit === 0 ? "done" : "failed" });
    }
  }

  return {
    items,
    meta,
    feed(text: string): void {
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let v: Input;
        try { v = JSON.parse(line); } catch { continue; }
        const p = (v.payload ?? {}) as Input;
        const at = Date.parse(str(v.timestamp)) || 0;
        switch (v.type) {
          case "turn_context":
            settings(p);
            break;
          case "compacted":
            items.push({ kind: "note", id: id(), text: "Conversation compacted", at });
            break;
          case "event_msg":
            if (p.type === "thread_settings_applied") settings((p.thread_settings ?? {}) as Input);
            else if (p.type === "turn_aborted") items.push({ kind: "note", id: id(), text: "You stopped the agent", at });
            else if (p.type === "token_count") {
              const info = (p.info ?? null) as Input | null;
              const last = (info?.last_token_usage ?? null) as Record<string, number> | null;
              const total = (info?.total_token_usage ?? null) as Record<string, number> | null;
              // Cached input is part of input_tokens in Codex's count.
              if (last) meta.context = last.input_tokens ?? 0;
              if (total) outputTokens = total.output_tokens ?? outputTokens;
              meta.output = outputTokens;
            } else if (p.type === "patch_apply_end") {
              const changes = (p.changes ?? {}) as Record<string, Input>;
              for (const [path, c] of Object.entries(changes)) {
                const kind = str(c.type) || Object.keys(c)[0] || "";
                if (kind === "add") noteFile({ path, isNew: true, at });
                else if (kind === "delete") noteFile({ path, deleted: true, at });
              }
            }
            break;
          case "response_item": {
            if (meta.started === null && at) meta.started = at;
            const t = str(p.type);
            if (t === "message") {
              if (p.role === "user") onUser(p.content, at);
              else if (p.role === "assistant") onAssistant(p.content, at);
            } else if (t === "function_call" || t === "custom_tool_call") onCall(p, at);
            else if (t === "function_call_output" || t === "custom_tool_call_output") onOutput(p, at);
            else if (t === "local_shell_call") {
              const action = (p.action ?? {}) as Input;
              onCall({ type: "function_call", call_id: p.call_id, name: "local_shell", arguments: { command: action.command } }, at);
            } else if (t === "web_search_call") {
              const action = (p.action ?? {}) as Input;
              const q = str(action.query) || (Array.isArray(action.queries) ? str((action.queries as unknown[])[0]) : "") || str(action.url);
              items.push({ kind: "step", id: id(), tool: "web_search", verb: action.type === "open_page" ? "Read" : "Searched the web for", target: q, done: true, at });
            } else if (t === "tool_search_call") {
              const args = (p.arguments ?? {}) as Input;
              items.push({ kind: "step", id: id(), tool: "tool_search", verb: "Loaded tools", target: firstLine(str(args.query), 60), done: true, at });
            }
            break;
          }
        }
      }
    },
  };
}
