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
  /** Questions it asked you, with your answers once you gave them. */
  questions?: AskedQuestion[];
  at: number;
}

export interface AskedQuestion {
  question: string;
  header?: string;
  multi?: boolean;
  options: Array<{ label: string; description?: string }>;
  /** What you picked (the option's label, or your own words); undefined while it waits. */
  answer?: string;
}

/** The answers in an AskUserQuestion result: `"question"="answer"` pairs, or the structured ones. */
export function askAnswers(text: string, extra: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const answers = extra && typeof extra === "object" ? (extra as Record<string, unknown>).answers : null;
  if (answers && typeof answers === "object") {
    for (const [q, a] of Object.entries(answers as Record<string, unknown>)) if (typeof a === "string") out.set(q, a);
    if (out.size) return out;
  }
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)) out.set(m[1], m[2]);
  return out;
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
    case "AskUserQuestion": {
      const questions: AskedQuestion[] = (Array.isArray(input.questions) ? (input.questions as Input[]) : []).map((q) => ({
        question: str(q.question),
        header: str(q.header) || undefined,
        multi: q.multiSelect === true,
        options: (Array.isArray(q.options) ? (q.options as Input[]) : []).map((o) => ({ label: str(o.label), description: str(o.description) || undefined })),
      }));
      const first = questions[0];
      return { tool: name, verb: "Asked you", target: first ? first.header || firstLine(first.question) : "a question", questions };
    }
    case "Monitor": {
      const cmd = str(input.command);
      return { tool: name, verb: "Watched", target: str(input.description) || firstLine(cmd), full: cmd || undefined };
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
export interface FileChange {
  path: string;
  name: string;
  added: number;
  removed: number;
  /** It did not exist until this conversation made it. */
  isNew: boolean;
  /** It was deleted. */
  deleted?: boolean;
  /** The reply that last changed it (ChatMeta.turn counts your messages). */
  turn: number;
  /** When it last changed. */
  at: number;
  /** The steps that changed it, oldest first: their diffs make up its diff. */
  steps: string[];
}

/** A command the agent left running on its own (a dev server, a build, a watch). */
export interface BgTask {
  id: string;
  /** What it is: its description, else its command. */
  label: string;
  command?: string;
  state: "running" | "done" | "failed" | "stopped";
  /** The file its output goes to, when the CLI says. */
  output?: string;
  at: number;
}

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
  /** Newest change first. */
  files: FileChange[];
  /** The plan as it stands (the latest TodoWrite), or null if it made none. */
  todos: Todo[] | null;
  /** How hard it thinks ("low" … "max", "auto"), as the CLI last said. */
  effort: string | null;
  /** Its permission mode, in the CLI's own words ("default", "acceptEdits", "plan", "bypassPermissions", "never"…). */
  permission: string | null;
  /** Commands it left running on their own; running ones first. */
  tasks: BgTask[];
  /** How many messages you have sent: the reply to the latest one is turn `turn`. */
  turn: number;
}

export function newMeta(): ChatMeta {
  return { model: null, context: 0, output: 0, started: null, files: [], todos: null, effort: null, permission: null, tasks: [], turn: 0 };
}

/** Keeps ChatMeta.files: one entry per file, summed, newest change first. */
export function fileLedger(meta: ChatMeta): (c: { path: string; name?: string; added?: number; removed?: number; isNew?: boolean; deleted?: boolean; step?: string; at: number }) => void {
  const files = new Map<string, FileChange>();
  // Newest first by the order changes happened in, not their clock (lines can share a timestamp).
  const last = new Map<string, number>();
  let n = 0;
  return (c) => {
    const key = c.path.replace(/\\/g, "/").toLowerCase();
    const fc = files.get(key) ?? { path: c.path, name: c.name ?? baseName(c.path), added: 0, removed: 0, isNew: false, turn: meta.turn, at: c.at, steps: [] };
    fc.added += c.added ?? 0;
    fc.removed += c.removed ?? 0;
    if (c.isNew) fc.isNew = true;
    if (c.deleted !== undefined) fc.deleted = c.deleted;
    if (c.step && !fc.steps.includes(c.step)) { fc.steps.push(c.step); fc.turn = meta.turn; fc.at = Math.max(fc.at, c.at); last.set(key, ++n); }
    if (!last.has(key)) last.set(key, ++n);
    files.set(key, fc);
    const order = (f: FileChange) => last.get(f.path.replace(/\\/g, "/").toLowerCase()) ?? 0;
    meta.files = [...files.values()].sort((a, b) => order(b) - order(a));
  };
}

/** Keeps ChatMeta.tasks: what each background command is doing, running ones first. */
export function taskLedger(meta: ChatMeta): (t: Partial<BgTask> & { id: string }) => void {
  const tasks = new Map<string, BgTask>();
  return (t) => {
    const cur = tasks.get(t.id) ?? { id: t.id, label: t.label ?? t.command ?? t.id, state: "running" as const, at: t.at ?? 0 };
    const next: BgTask = { ...cur, ...Object.fromEntries(Object.entries(t).filter(([, x]) => x !== undefined && x !== "")) } as BgTask;
    if (!next.label) next.label = next.command ?? next.id;
    tasks.set(t.id, next);
    meta.tasks = [...tasks.values()].sort((a, b) => (a.state === "running" ? 0 : 1) - (b.state === "running" ? 0 : 1) || b.at - a.at);
  };
}

/** A CLI's word for how a background task ended, as ours. */
export function taskState(status: string): BgTask["state"] {
  const s = status.toLowerCase();
  if (/run|start|pending/.test(s)) return "running";
  if (/fail|error/.test(s)) return "failed";
  if (/stop|kill|cancel|abort|interrupt/.test(s)) return "stopped";
  return "done";
}

/** Claude Code's <task-notification> text: which tasks, how they ended, where the output is. */
export function parseTaskNotice(raw: string): Array<{ id: string; state: BgTask["state"]; output?: string; summary?: string }> {
  if (!raw.includes("<task-notification>")) return [];
  const out: Array<{ id: string; state: BgTask["state"]; output?: string; summary?: string }> = [];
  for (const block of raw.split("<task-notification>").slice(1)) {
    const tag = (n: string) => {
      const a = block.indexOf(`<${n}>`);
      const b = a < 0 ? -1 : block.indexOf(`</${n}>`, a);
      return a < 0 || b < 0 ? "" : block.slice(a + n.length + 2, b).trim();
    };
    const status = tag("status");
    if (!status) continue;
    const output = tag("output-file") || undefined;
    const summary = tag("summary") || undefined;
    for (const m of block.matchAll(/<task-id>([^<]+)<\/task-id>/g)) {
      const id = m[1].trim();
      if (!id.startsWith("__")) out.push({ id, state: taskState(status), output, summary });
    }
  }
  return out;
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
  const meta = newMeta();
  const noteFile = fileLedger(meta);
  const noteTask = taskLedger(meta);
  const counted = new Set<string>(); // message ids whose usage is already summed
  const queuedIds = new Set<string>(); // messages already shown from the queue
  let lastRun = ""; // which run of the CLI wrote the last line
  let n = 0;
  const id = () => `c${n++}`;

  function onUser(v: Input, at: number): void {
    if (queuedIds.has(str(v.uuid))) return; // already shown when it was queued
    const msg = (v.message ?? {}) as Input;
    const content = msg.content;
    if (typeof content === "string") {
      taskNotices(content);
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
        if (step.questions) {
          const got = askAnswers(out, extra);
          for (const q of step.questions) q.answer = got.get(q.question);
        }
        if (extra && step.full && (step.verb === "Edited" || step.verb === "Wrote") && extra.type === "create") {
          noteFile({ path: step.full, isNew: true, at });
        }
        // A command left running on its own: Bash/Monitor with run_in_background.
        const bg = extra ? str(extra.backgroundTaskId) || str(extra.taskId) : "";
        if (bg) noteTask({ id: bg, label: step.target, command: step.full, state: "running", at });
      } else if (part.type === "text") text += (text ? "\n" : "") + str(part.text);
      else if (part.type === "image") images++;
    }
    if (text || images) userText(text, images, v, at, imagesOf(content));
  }

  function userText(raw: string, images: number, v: Input, at: number, pics: ChatImage[] = []): void {
    const origin = (v.origin ?? null) as Input | null;
    taskNotices(raw);
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
    meta.turn++;
    items.push({ kind: "user", id: id(), text, images, ...(pics.length ? { pics } : {}), at });
  }

  /** Background commands finishing, as the CLI tells the agent. */
  function taskNotices(raw: string): void {
    for (const t of parseTaskNotice(raw)) noteTask({ id: t.id, state: t.state, output: t.output });
  }

  /** A message you typed while the agent was working: the CLI queues it and
   *  hands it over mid-turn as an attachment, not as a user line. */
  function onQueued(v: Input, at: number): void {
    const a = (v.attachment ?? {}) as Input;
    if (a.type !== "queued_command") return;
    if (typeof a.prompt === "string") taskNotices(a.prompt);
    if (a.commandMode !== undefined && a.commandMode !== "prompt") return;
    const origin = (a.origin ?? null) as Input | null;
    if (origin ? origin.kind !== "human" : a.humanTurn !== true) return;
    const source = str(a.source_uuid);
    if (source) {
      if (queuedIds.has(source)) return;
      queuedIds.add(source);
    }
    const when = Date.parse(str(a.timestamp)) || at;
    if (typeof a.prompt === "string") { userText(a.prompt, 0, { origin: { kind: "human" } }, when); return; }
    if (!Array.isArray(a.prompt)) return;
    let text = "";
    let images = 0;
    for (const part of a.prompt as Input[]) {
      if (part.type === "text") text += (text ? "\n" : "") + str(part.text);
      else if (part.type === "image") images++;
    }
    if (text || images) userText(text, images, { origin: { kind: "human" } }, when, imagesOf(a.prompt));
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
        // Stopping a background command by hand.
        if (/^(TaskStop|KillShell|KillBash)$/.test(str(part.name))) {
          const inp = (part.input ?? {}) as Input;
          const bg = str(inp.task_id) || str(inp.shell_id) || str(inp.id);
          if (bg) noteTask({ id: bg, state: "stopped" });
        }
        if (step.todos) meta.todos = step.todos;
        if (step.full && (step.verb === "Edited" || step.verb === "Wrote")) {
          noteFile({ path: step.full, name: step.target, added: step.added, removed: step.removed, step: step.id, at });
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
        // A new run of the CLI (resumed later): what the last run left in the background died with it.
        const run = str(v.session_id);
        if (run && run !== lastRun) {
          if (lastRun) for (const t of meta.tasks) if (t.state === "running") noteTask({ id: t.id, state: "stopped" });
          lastRun = run;
        }
        // Each reply says the effort it ran at; each of your messages, the permission mode.
        if (typeof v.effort === "string" && v.effort) meta.effort = v.effort;
        if (typeof v.permissionMode === "string" && v.permissionMode) meta.permission = v.permissionMode;
        if (v.type === "user") onUser(v, at);
        else if (v.type === "assistant") onAssistant(v, at);
        else if (v.type === "attachment") {
          const a = (v.attachment ?? {}) as Input;
          if (a.type === "task_status" && str(a.taskId)) {
            const shell = (a.shell ?? {}) as Input;
            noteTask({ id: str(a.taskId), label: str(a.description), command: str(shell.command) || undefined, state: taskState(str(a.status)), output: str(a.outputFilePath) || undefined });
          } else onQueued(v, at);
        }
        else if (v.type === "system" && v.subtype === "compact_boundary") items.push({ kind: "note", id: id(), text: "Conversation compacted", at });
      }
    },
  };
}
