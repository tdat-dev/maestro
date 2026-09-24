// Turns a Claude Code transcript (~/.claude/projects/<dir>/<session>.jsonl)
// into what the chat view shows: your messages, the agent's replies, and the
// steps it took in between (read a file, edited one, ran a command…), each
// with its result. Pure: feed it lines, read `items`. No DOM here.

export interface DiffLine { sign: " " | "+" | "-"; text: string }
export interface Todo { text: string; state: "pending" | "in_progress" | "completed" }

export interface StepItem {
  kind: "step";
  id: string;
  tool: string;
  /** "Ran", "Edited", "Read"… */
  verb: string;
  /** What it acted on: a file name, a command, a search. */
  target: string;
  /** Full path or command, for a tooltip. */
  full?: string;
  /** The target is code (a file, a command, a pattern), not words. */
  code?: boolean;
  /** Tool output, trimmed. */
  output?: string;
  error?: boolean;
  done: boolean;
  diff?: DiffLine[];
  added?: number;
  removed?: number;
  todos?: Todo[];
  at: number;
}
export type ChatItem =
  | { kind: "user"; id: string; text: string; images: number; at: number }
  | { kind: "text"; id: string; text: string; at: number }
  | { kind: "note"; id: string; text: string; at: number }
  | StepItem;

const MAX_OUTPUT = 6000;
const MAX_DIFF_LINES = 400;

/** The last part of a path. */
export function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

function firstLine(s: string, max = 120): string {
  const line = s.trim().split(/\r?\n/)[0] ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** Line diff by longest common subsequence; big inputs fall back to all-out, all-in. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length * b.length > 160_000) {
    return [...a.map((text) => ({ sign: "-" as const, text })), ...b.map((text) => ({ sign: "+" as const, text }))];
  }
  const n = a.length, m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ sign: " ", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ sign: "-", text: a[i++] });
    else out.push({ sign: "+", text: b[j++] });
  }
  while (i < n) out.push({ sign: "-", text: a[i++] });
  while (j < m) out.push({ sign: "+", text: b[j++] });
  return out;
}

function countDiff(d: DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of d) { if (l.sign === "+") added++; else if (l.sign === "-") removed++; }
  return { added, removed };
}

type Input = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** How a tool call reads in the chat: a verb, what it touched, and extras. */
export function describeTool(name: string, input: Input): Omit<StepItem, "kind" | "id" | "done" | "at"> {
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  switch (name) {
    case "Bash":
    case "PowerShell": {
      const cmd = str(input.command);
      const said = str(input.description);
      return { tool: name, verb: "Ran", target: said || firstLine(cmd), full: cmd, code: !said };
    }
    case "Read":
      return { tool: name, verb: "Read", target: baseName(file), full: file, code: true };
    case "Edit": {
      const diff = lineDiff(str(input.old_string), str(input.new_string)).slice(0, MAX_DIFF_LINES);
      return { tool: name, verb: "Edited", target: baseName(file), full: file, code: true, diff, ...countDiff(diff) };
    }
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [];
      const diff = edits.flatMap((e, k) => [
        ...(k ? [{ sign: " " as const, text: "⋯" }] : []),
        ...lineDiff(str(e.old_string), str(e.new_string)),
      ]).slice(0, MAX_DIFF_LINES);
      return { tool: name, verb: "Edited", target: baseName(file), full: file, code: true, diff, ...countDiff(diff) };
    }
    case "Write": {
      const content = str(input.content);
      const diff = content.split(/\r?\n/).slice(0, MAX_DIFF_LINES).map((text) => ({ sign: "+" as const, text }));
      return { tool: name, verb: "Wrote", target: baseName(file), full: file, code: true, diff, added: content ? content.split(/\r?\n/).length : 0, removed: 0 };
    }
    case "NotebookEdit":
      return { tool: name, verb: "Edited", target: baseName(file), full: file, code: true };
    case "Grep":
      return { tool: name, verb: "Searched for", target: str(input.pattern), code: true, full: str(input.path) || undefined };
    case "Glob":
      return { tool: name, verb: "Looked for files", target: str(input.pattern), code: true };
    case "LS":
      return { tool: name, verb: "Listed", target: baseName(file), full: file, code: true };
    case "WebSearch":
      return { tool: name, verb: "Searched the web for", target: str(input.query) };
    case "WebFetch": {
      const url = str(input.url);
      let host = url;
      try { host = new URL(url).host; } catch { /* keep the url */ }
      return { tool: name, verb: "Read", target: host, full: url };
    }
    case "Task":
    case "Agent":
      return { tool: name, verb: "Asked a helper agent to", target: str(input.description) || firstLine(str(input.prompt)) };
    case "TodoWrite": {
      const todos = (Array.isArray(input.todos) ? (input.todos as Input[]) : []).map((t) => ({
        text: str(t.content) || str(t.activeForm),
        state: (["pending", "in_progress", "completed"].includes(str(t.status)) ? str(t.status) : "pending") as Todo["state"],
      }));
      return { tool: name, verb: "Updated the plan", target: `${todos.filter((t) => t.state === "completed").length} of ${todos.length} done`, todos };
    }
    case "Skill":
      return { tool: name, verb: "Used the skill", target: str(input.skill) || str(input.command) };
    case "ToolSearch":
      return { tool: name, verb: "Loaded tools", target: firstLine(str(input.query), 60) };
    case "ExitPlanMode":
      return { tool: name, verb: "Proposed a plan", target: "" };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      if (mcp) return { tool: name, verb: "Used", target: `${mcp[1].replace(/[_-]+/g, " ")} · ${mcp[2].replace(/_/g, " ")}` };
      return { tool: name, verb: "Used", target: name };
    }
  }
}

/** Text of a tool_result's content, whatever shape it came in. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && (c as Input).type === "text" ? str((c as Input).text) : (c as Input)?.type === "image" ? "[image]" : "")).join("\n");
  }
  return "";
}

function trimOutput(s: string): string {
  const t = s.replace(/\s+$/, "");
  return t.length > MAX_OUTPUT ? t.slice(0, MAX_OUTPUT) + "\n…" : t;
}

/** What you typed, without the reminders and hook text the CLI adds around it. */
function cleanUserText(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

export interface Chat {
  items: ChatItem[];
  /** Feed complete JSONL lines (one chunk from the transcript). */
  feed(text: string): void;
}

export function createChat(): Chat {
  const items: ChatItem[] = [];
  const steps = new Map<string, StepItem>();
  let n = 0;
  const id = () => `c${n++}`;

  function onUser(v: Input, at: number): void {
    const msg = (v.message ?? {}) as Input;
    const content = msg.content;
    if (typeof content === "string") {
      userText(content, 0, v, at);
      return;
    }
    if (!Array.isArray(content)) return;
    let text = "";
    let images = 0;
    for (const part of content as Input[]) {
      if (part.type === "tool_result") {
        const step = steps.get(str(part.tool_use_id));
        if (!step) continue;
        const extra = (v.toolUseResult ?? null) as Input | null;
        let out = resultText(part.content);
        if (extra && (typeof extra.stdout === "string" || typeof extra.stderr === "string")) {
          out = [str(extra.stdout), str(extra.stderr)].filter(Boolean).join("\n");
        }
        step.output = trimOutput(out);
        step.error = part.is_error === true;
        step.done = true;
      } else if (part.type === "text") text += (text ? "\n" : "") + str(part.text);
      else if (part.type === "image") images++;
    }
    if (text || images) userText(text, images, v, at);
  }

  function userText(raw: string, images: number, v: Input, at: number): void {
    const origin = (v.origin ?? null) as Input | null;
    if (origin && origin.kind !== "human") return; // hook output, task notices…
    const cmd = /<command-name>([^<]*)<\/command-name>(?:[\s\S]*?<command-args>([^<]*)<\/command-args>)?/.exec(raw);
    if (cmd) { items.push({ kind: "note", id: id(), text: `${cmd[1]}${cmd[2] ? ` ${cmd[2]}` : ""}`.trim(), at }); return; }
    if (/<local-command-(stdout|stderr)>|<local-command-caveat>/.test(raw)) return;
    if (/^\[Request interrupted by user/.test(raw.trim())) { items.push({ kind: "note", id: id(), text: "You stopped the agent", at }); return; }
    const text = cleanUserText(raw);
    if (!text && !images) return;
    items.push({ kind: "user", id: id(), text, images, at });
  }

  function onAssistant(v: Input, at: number): void {
    const content = ((v.message ?? {}) as Input).content;
    if (!Array.isArray(content)) return;
    for (const part of content as Input[]) {
      if (part.type === "text") {
        const text = str(part.text).trim();
        if (text && text !== "(no content)") items.push({ kind: "text", id: id(), text, at });
      } else if (part.type === "tool_use") {
        const tid = str(part.id);
        if (steps.has(tid)) continue;
        const step: StepItem = { kind: "step", id: id(), done: false, at, ...describeTool(str(part.name), (part.input ?? {}) as Input) };
        steps.set(tid, step);
        items.push(step);
      }
    }
  }

  return {
    items,
    feed(text: string): void {
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let v: Input;
        try { v = JSON.parse(line); } catch { continue; }
        if (v.isSidechain === true || v.isMeta === true) continue; // a helper agent's inner steps, injected context
        const at = Date.parse(str(v.timestamp)) || 0;
        if (v.type === "user") onUser(v, at);
        else if (v.type === "assistant") onAssistant(v, at);
        else if (v.type === "system" && v.subtype === "compact_boundary") items.push({ kind: "note", id: id(), text: "Conversation compacted", at });
      }
    },
  };
}
