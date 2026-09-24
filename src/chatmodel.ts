// Turns a Claude Code transcript (~/.claude/projects/<dir>/<session>.jsonl)
// into what the chat view shows: your messages, the agent's replies, and the
// steps it took in between (read a file, edited one, ran a command…), each
// with its result. Pure: feed it lines, read `items`. No DOM here.

export interface DiffLine { sign: " " | "+" | "-"; text: string }
/** A picture in the conversation: a screenshot a tool took, an image file it
 *  opened, or one you pasted. Base64, as the transcript keeps it. */
export interface ChatImage { media: string; data: string }
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
  /** What the step saw: screenshots and images its tool returned. */
  images?: ChatImage[];
  at: number;
}
export type ChatItem =
  | { kind: "user"; id: string; text: string; images: number; pics?: ChatImage[]; at: number }
  | { kind: "text"; id: string; text: string; at: number }
  | { kind: "note"; id: string; text: string; at: number }
  | StepItem;

const MAX_OUTPUT = 6000;
/** Pictures kept per step or message; a burst of screenshots keeps its last ones. */
const MAX_IMAGES = 8;
/** Formats an <img> shows as a picture and nothing else (no SVG: it can carry script). */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The pictures in a message's or a tool result's content. */
export function imagesOf(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return [];
  const out: ChatImage[] = [];
  for (const c of content as Input[]) {
    if (!c || typeof c !== "object" || c.type !== "image") continue;
    const src = (c.source ?? {}) as Input;
    const media = str(src.media_type).toLowerCase();
    const data = str(src.data);
    if (src.type === "base64" && IMAGE_TYPES.has(media) && /^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 256))) out.push({ media, data });
  }
  return out.slice(-MAX_IMAGES);
}
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
      return { tool: name, verb: /\.(png|jpe?g|gif|webp|bmp)$/i.test(file) ? "Looked at" : "Read", target: baseName(file), full: file, code: true };
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
      // A browser or desktop screenshot, whichever server took it.
      if (mcp && (str(input.action) === "screenshot" || /screenshot|snapshot/i.test(mcp[2]))) {
        return { tool: name, verb: "Took a screenshot", target: mcp[1].replace(/^plugin_[^_]+_/, "").replace(/[_-]+/g, " ") };
      }
      if (mcp) return { tool: name, verb: "Used", target: `${mcp[1].replace(/[_-]+/g, " ")} · ${mcp[2].replace(/_/g, " ")}` };
      return { tool: name, verb: "Used", target: name };
    }
  }
}

/** Text of a tool_result's content, whatever shape it came in. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && (c as Input).type === "text" ? str((c as Input).text) : "")).filter(Boolean).join("\n");
  }
  return "";
}

function trimOutput(s: string): string {
  const t = s.replace(/\s+$/, "");
  return t.length > MAX_OUTPUT ? t.slice(0, MAX_OUTPUT) + "\n…" : t;
}

/** One turn: your message and what the agent did and said until your next one. */
export interface Turn { start: number; end: number; items: ChatItem[]; took: number }

/** Split items into turns, each starting at one of your messages. */
export function turnsOf(items: ChatItem[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  items.forEach((it, i) => {
    if (it.kind === "user" || !cur) {
      cur = { start: i, end: i, items: [], took: 0 };
      turns.push(cur);
    }
    cur.items.push(it);
    cur.end = i;
  });
  for (const t of turns) {
    const first = t.items[0]?.at ?? 0;
    const last = t.items[t.items.length - 1]?.at ?? 0;
    t.took = first && last ? Math.max(0, last - first) : 0;
  }
  return turns;
}

/** What you typed, without the reminders and hook text the CLI adds around it. */
function cleanUserText(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

/** A file the agent changed in this conversation, summed over its edits. */
export interface FileChange { path: string; name: string; added: number; removed: number }

/** What the conversation says about itself, for the side panel and composer. */
export interface ChatMeta {
  /** Model of the latest reply ("claude-opus-5-5"). */
  model: string | null;
  /** Tokens the model read for its latest reply: roughly how full the context is. */
  context: number;
  /** Tokens it has written in this conversation. */
  output: number;
  /** When the conversation began. */
  started: number | null;
  files: FileChange[];
  /** The plan as it stands (the latest TodoWrite), or null if it made none. */
  todos: Todo[] | null;
}

export interface Chat {
  items: ChatItem[];
  meta: ChatMeta;
  /** Feed complete JSONL lines (one chunk from the transcript). */
  feed(text: string): void;
}

export function createChat(): Chat {
  const items: ChatItem[] = [];
  const steps = new Map<string, StepItem>();
  const meta: ChatMeta = { model: null, context: 0, output: 0, started: null, files: [], todos: null };
  const files = new Map<string, FileChange>();
  const counted = new Set<string>(); // message ids whose usage is already summed
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
        const pics = imagesOf(part.content);
        if (pics.length) step.images = pics;
        step.error = part.is_error === true;
        step.done = true;
      } else if (part.type === "text") text += (text ? "\n" : "") + str(part.text);
      else if (part.type === "image") images++;
    }
    if (text || images) userText(text, images, v, at, imagesOf(content));
  }

  function userText(raw: string, images: number, v: Input, at: number, pics: ChatImage[] = []): void {
    const origin = (v.origin ?? null) as Input | null;
    if (origin && origin.kind !== "human") return; // hook output, task notices…
    // /model answers with the model it switched to; that is the model from now
    // on, before any reply comes back with its id.
    const switched = /<local-command-stdout>Set model to `([^`]+)`/.exec(raw);
    if (switched) {
      meta.model = switched[1].replace(/\s*\(default\)\s*$/i, "").trim();
      items.push({ kind: "note", id: id(), text: `Switched to ${meta.model}`, at });
      return;
    }
    const cmd = /<command-name>([^<]*)<\/command-name>(?:[\s\S]*?<command-args>([^<]*)<\/command-args>)?/.exec(raw);
    // /model is said by its answer above
    if (cmd && cmd[1] === "/model") return;
    if (cmd) { items.push({ kind: "note", id: id(), text: `${cmd[1]}${cmd[2] ? ` ${cmd[2]}` : ""}`.trim(), at }); return; }
    if (/<local-command-(stdout|stderr)>|<local-command-caveat>/.test(raw)) return;
    if (/^\[Request interrupted by user/.test(raw.trim())) { items.push({ kind: "note", id: id(), text: "You stopped the agent", at }); return; }
    const text = cleanUserText(raw);
    if (!text && !images) return;
    items.push({ kind: "user", id: id(), text, images, ...(pics.length ? { pics } : {}), at });
  }

  function onAssistant(v: Input, at: number): void {
    const msg = (v.message ?? {}) as Input;
    const content = msg.content;
    if (typeof msg.model === "string" && msg.model !== "<synthetic>") meta.model = msg.model;
    // One reply is written as several lines that share its id and its usage.
    const usage = msg.usage as Record<string, number> | undefined;
    const mid = str(msg.id);
    if (usage && mid && !counted.has(mid)) {
      counted.add(mid);
      meta.output += usage.output_tokens ?? 0;
      meta.context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    }
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
        if (step.todos) meta.todos = step.todos;
        if (step.full && (step.verb === "Edited" || step.verb === "Wrote")) {
          const fc = files.get(step.full) ?? { path: step.full, name: step.target, added: 0, removed: 0 };
          fc.added += step.added ?? 0;
          fc.removed += step.removed ?? 0;
          files.set(step.full, fc);
          meta.files = [...files.values()];
        }
      }
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
        if (v.isSidechain === true || v.isMeta === true) continue; // a helper agent's inner steps, injected context
        const at = Date.parse(str(v.timestamp)) || 0;
        if (at && meta.started === null && (v.type === "user" || v.type === "assistant")) meta.started = at;
        if (v.type === "user") onUser(v, at);
        else if (v.type === "assistant") onAssistant(v, at);
        else if (v.type === "system" && v.subtype === "compact_boundary") items.push({ kind: "note", id: id(), text: "Conversation compacted", at });
      }
    },
  };
}
