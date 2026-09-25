// Turns an opencode session into what the chat view shows, the same items and
// meta as chatmodel.ts builds from a Claude Code transcript. The rows come from
// opencode's SQLite store (opencode_transcript): `message` rows say who spoke,
// with model, agent and tokens; `part` rows hold the text and the tool calls.
// A part is rewritten in place while its tool runs (pending → running →
// completed), so rows are upserted by id, never appended twice. Pure: no DOM.

import {
  baseName, fileLedger, lineDiff, newMeta,
  type Chat, type ChatImage, type ChatItem, type DiffLine, type StepItem, type Todo,
} from "./chatmodel";

type Input = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const MAX_OUTPUT = 6000;
const MAX_DIFF_LINES = 400;
const MAX_IMAGES = 8;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function firstLine(s: string, max = 120): string {
  const line = s.trim().split(/\r?\n/)[0] ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function trimOutput(s: string): string {
  const t = s.replace(/\r\n/g, "\n").trim();
  return t.length > MAX_OUTPUT ? t.slice(0, MAX_OUTPUT) + "\n…" : t;
}

function countDiff(d: DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of d) { if (l.sign === "+") added++; else if (l.sign === "-") removed++; }
  return { added, removed };
}

/** The lines of a unified diff (what opencode keeps for an edit), headers left out. */
export function unifiedDiff(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let inHunk = false;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("@@")) { if (out.length) out.push({ sign: " ", text: "⋯" }); inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const sign = line[0];
    if (sign === "+" || sign === "-" || sign === " ") out.push({ sign, text: line.slice(1) });
    else if (line === "") out.push({ sign: " ", text: "" });
  }
  while (out.length && out[out.length - 1].sign === " " && out[out.length - 1].text === "") out.pop();
  return out.slice(0, MAX_DIFF_LINES);
}

/** A picture kept as a data URL (a pasted image, a screenshot a tool read). */
function pictureOf(url: string, mime: string): ChatImage | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  const media = (m?.[1] ?? mime).toLowerCase();
  if (!m || !IMAGE_TYPES.has(media)) return null;
  return { media, data: m[2] };
}

/** The files an apply_patch body adds, changes or deletes. */
function patchFiles(body: string): Array<{ path: string; kind: "add" | "update" | "delete" }> {
  const out: Array<{ path: string; kind: "add" | "update" | "delete" }> = [];
  for (const m of body.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    out.push({ path: m[2].trim(), kind: m[1].toLowerCase() as "add" | "update" | "delete" });
  }
  return out;
}

/** How an opencode tool call reads in the chat: a verb, what it touched, and extras. */
export function describeOpencodeTool(tool: string, input: Input, metadata: Input = {}): Omit<StepItem, "kind" | "id" | "done" | "at"> {
  const file = str(input.filePath) || str(input.file_path) || str(input.path) || str(metadata.filepath);
  switch (tool) {
    case "bash": {
      const cmd = str(input.command);
      const said = str(input.description);
      return { tool, verb: "Ran", target: said || firstLine(cmd), full: cmd, code: !said };
    }
    case "read":
      return { tool, verb: /\.(png|jpe?g|gif|webp|bmp)$/i.test(file) ? "Looked at" : "Read", target: baseName(file), full: file, code: true };
    case "edit":
    case "multiedit": {
      const fd = (metadata.filediff ?? {}) as Input;
      const patch = str(fd.patch) || str(metadata.diff);
      let diff: DiffLine[];
      if (patch) diff = unifiedDiff(patch);
      else if (Array.isArray(input.edits)) {
        diff = (input.edits as Input[]).flatMap((e, k) => [
          ...(k ? [{ sign: " " as const, text: "⋯" }] : []),
          ...lineDiff(str(e.oldString), str(e.newString)),
        ]).slice(0, MAX_DIFF_LINES);
      } else diff = lineDiff(str(input.oldString), str(input.newString)).slice(0, MAX_DIFF_LINES);
      const counted = countDiff(diff);
      const added = typeof fd.additions === "number" ? fd.additions : counted.added;
      const removed = typeof fd.deletions === "number" ? fd.deletions : counted.removed;
      return { tool, verb: "Edited", target: baseName(file), full: file, code: true, diff, added, removed };
    }
    case "write": {
      const content = str(input.content);
      const lines = content ? content.split(/\r?\n/) : [];
      return { tool, verb: "Wrote", target: baseName(file), full: file, code: true, diff: lines.slice(0, MAX_DIFF_LINES).map((text) => ({ sign: "+" as const, text })), added: lines.length, removed: 0 };
    }
    case "patch":
    case "apply_patch": {
      const body = str(input.patchText) || str(input.patch) || str(input.input);
      const files = patchFiles(body);
      const target = files.length === 1 ? baseName(files[0].path) : `${files.length} files`;
      return { tool, verb: "Edited", target, full: files.map((f) => f.path).join("\n") || undefined, code: files.length === 1 };
    }
    case "glob":
      return { tool, verb: "Looked for files", target: str(input.pattern), code: true };
    case "grep":
      return { tool, verb: "Searched for", target: str(input.pattern), code: true, full: str(input.path) || undefined };
    case "list":
    case "ls":
      return { tool, verb: "Listed", target: baseName(file || "."), full: file || undefined, code: true };
    case "webfetch": {
      const url = str(input.url);
      let host = url;
      try { host = new URL(url).host; } catch { /* keep the url */ }
      return { tool, verb: "Read", target: host, full: url };
    }
    case "websearch":
      return { tool, verb: "Searched the web for", target: str(input.query) };
    case "todowrite":
    case "todoread": {
      const todos: Todo[] = (Array.isArray(input.todos) ? (input.todos as Input[]) : []).map((t) => ({
        text: str(t.content),
        state: (["pending", "in_progress", "completed"].includes(str(t.status)) ? str(t.status) : "pending") as Todo["state"],
      }));
      return { tool, verb: "Updated the plan", target: `${todos.filter((t) => t.state === "completed").length} of ${todos.length} done`, todos };
    }
    case "task":
      return { tool, verb: "Asked a helper agent to", target: str(input.description) || firstLine(str(input.prompt)) };
    case "skill":
      return { tool, verb: "Used the skill", target: str(input.name) };
    case "question": {
      const qs = Array.isArray(input.questions) ? (input.questions as Input[]) : [];
      return { tool, verb: "Asked you", target: firstLine(str(qs[0]?.question) || str(input.question), 80) };
    }
    default:
      return { tool, verb: "Used", target: tool.replace(/[_-]+/g, " ") };
  }
}

/** One opencode row as opencode_transcript hands it over. */
interface Row { kind: "message" | "part"; id: string; messageId: string; created: number; updated: number; data: Input }

interface Msg { role: string; created: number; parts: Map<string, Input>; partAt: Map<string, number> }

/** opencode ids start with a time: "prt_0b55a7148001…", "msg_0b5595294001…". Their tails sort in time order. */
const order = (id: string) => id.replace(/^[a-z]+_/, "");

export function createOpencodeChat(): Chat {
  const items: ChatItem[] = [];
  const meta = newMeta();
  const noteFile = fileLedger(meta);
  const msgs = new Map<string, Msg>();
  /** What the chat shows, by the row it came from, kept in time order. */
  const shown = new Map<string, ChatItem>();
  const keys = new Map<string, string>(); // shown id → sort key
  const filed = new Set<string>(); // tool parts whose file changes are counted
  const users = new Set<string>(); // user messages already counted as a turn
  const outputs = new Map<string, number>(); // output tokens per reply, summed once
  let latestUser = 0;
  let latestReply = 0;

  const put = (key: string, sort: string, it: ChatItem) => { shown.set(key, it); keys.set(key, sort); };

  function msgOf(id: string): Msg {
    let m = msgs.get(id);
    if (!m) { m = { role: "", created: 0, parts: new Map(), partAt: new Map() }; msgs.set(id, m); }
    return m;
  }

  /** Your message, from its text parts and pictures. */
  function drawUser(id: string, m: Msg): void {
    let text = "";
    let images = 0;
    const pics: ChatImage[] = [];
    for (const [, p] of [...m.parts.entries()].sort(([a], [b]) => (order(a) < order(b) ? -1 : 1))) {
      if (p.type === "text" && p.synthetic !== true && p.ignored !== true) text += (text ? "\n" : "") + str(p.text);
      else if (p.type === "file") {
        const pic = pictureOf(str(p.url), str(p.mime));
        if (pic) { pics.push(pic); images++; }
      }
    }
    text = text.trim();
    if (!text && !images) return;
    if (!users.has(id)) { users.add(id); meta.turn++; }
    put(id, order(id), { kind: "user", id, text, images, ...(pics.length ? { pics: pics.slice(-MAX_IMAGES) } : {}), at: m.created });
  }

  function onMessage(r: Row): void {
    const d = r.data;
    const m = msgOf(r.id);
    const knew = !!m.role;
    m.role = str(d.role);
    // Parts that came in before their message waited for its role: draw them now.
    if (!knew && m.role === "assistant") for (const [pid, p] of m.parts) drawPart(pid, p, m.partAt.get(pid) ?? r.created);
    const time = (d.time ?? {}) as Input;
    m.created = num(time.created) || r.created;
    if (meta.started === null || m.created < meta.started) meta.started = m.created;
    if (m.role === "user") {
      // The mode it runs in (build / plan) and the model's variant (its effort) are chosen per message.
      if (m.created >= latestUser) {
        latestUser = m.created;
        if (str(d.agent)) meta.permission = str(d.agent);
        const model = (d.model ?? {}) as Input;
        if (str(model.variant)) meta.effort = str(model.variant);
      }
      drawUser(r.id, m);
      return;
    }
    if (m.role !== "assistant") return;
    if (m.created >= latestReply) {
      latestReply = m.created;
      if (str(d.modelID)) meta.model = str(d.modelID);
      const tokens = (d.tokens ?? {}) as Input;
      const cache = (tokens.cache ?? {}) as Input;
      const context = num(tokens.input) + num(cache.read) + num(cache.write);
      if (context) meta.context = context;
    }
    const tokens = (d.tokens ?? {}) as Input;
    outputs.set(r.id, num(tokens.output) + num(tokens.reasoning));
    meta.output = [...outputs.values()].reduce((a, b) => a + b, 0);
    const err = (d.error ?? null) as Input | null;
    if (err) {
      const data = (err.data ?? {}) as Input;
      const said = str(data.message) || str(err.name) || "Something went wrong";
      put(`${r.id}:err`, `${order(r.id)}~`, { kind: "note", id: `${r.id}:err`, text: str(err.name) === "MessageAbortedError" ? "You stopped the agent" : `Error: ${firstLine(said, 160)}`, at: m.created });
    }
  }

  function onPart(r: Row): void {
    const m = msgOf(r.messageId);
    m.parts.set(r.id, r.data);
    m.partAt.set(r.id, r.created);
    if (m.role === "user") drawUser(r.messageId, m);
    else if (m.role === "assistant") drawPart(r.id, r.data, r.created);
    // else: its message has not come yet; drawn when it does
  }

  /** One part of a reply. Step-start/finish, reasoning, snapshots and patches are not shown. */
  function drawPart(id: string, p: Input, at: number): void {
    switch (str(p.type)) {
      case "text": {
        const text = str(p.text).trim();
        if (text && p.synthetic !== true) put(id, order(id), { kind: "text", id, text, at });
        else { shown.delete(id); keys.delete(id); }
        return;
      }
      case "compaction":
        put(id, order(id), { kind: "note", id, text: "Conversation compacted", at });
        return;
      case "subtask":
        put(id, order(id), { kind: "step", id, tool: "subtask", verb: "Asked a helper agent to", target: str(p.description) || str(p.command), done: true, at });
        return;
      case "tool":
        onTool({ kind: "part", id, messageId: "", created: at, updated: at, data: p }, p, at);
        return;
    }
  }

  function onTool(r: Row, p: Input, at: number): void {
    const tool = str(p.tool);
    const state = (p.state ?? {}) as Input;
    const status = str(state.status);
    const input = (state.input ?? {}) as Input;
    const md = (state.metadata ?? {}) as Input;
    const step: StepItem = { kind: "step", id: r.id, done: status === "completed" || status === "error", at, ...describeOpencodeTool(tool, input, md) };
    if (status === "error") { step.error = true; step.output = trimOutput(str(state.error)); }
    else {
      const out = str(state.output) || str(md.output);
      if (out) step.output = trimOutput(out);
    }
    // A picture the tool read or took comes back as an attachment.
    const pics = (Array.isArray(state.attachments) ? (state.attachments as Input[]) : [])
      .map((a) => pictureOf(str(a.url), str(a.mime)))
      .filter((x): x is ChatImage => !!x);
    if (pics.length) step.images = pics.slice(-MAX_IMAGES);
    if (step.todos?.length) meta.todos = step.todos;
    put(r.id, order(r.id), step);
    if (status !== "completed" || filed.has(r.id)) return;
    filed.add(r.id);
    if (tool === "edit" || tool === "multiedit") {
      noteFile({ path: step.full ?? "", name: step.target, added: step.added, removed: step.removed, step: r.id, at });
    } else if (tool === "write") {
      noteFile({ path: step.full ?? "", name: step.target, added: step.added, removed: 0, isNew: md.exists === false, step: r.id, at });
    } else if (tool === "patch" || tool === "apply_patch") {
      const body = str(input.patchText) || str(input.patch) || str(input.input);
      for (const f of patchFiles(body)) noteFile({ path: f.path, isNew: f.kind === "add", deleted: f.kind === "delete" ? true : undefined, step: r.id, at });
    }
  }

  function redraw(): void {
    // A reply's error goes after the last of its parts.
    for (const [key] of shown) {
      if (!key.endsWith(":err")) continue;
      const m = msgs.get(key.slice(0, -4));
      const last = [...(m?.parts.keys() ?? [])].map(order).sort().pop() ?? order(key.slice(0, -4));
      keys.set(key, `${last}~`);
    }
    const sorted = [...shown.entries()].sort(([a], [b]) => {
      const ka = keys.get(a)!, kb = keys.get(b)!;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    items.length = 0;
    for (const [, it] of sorted) items.push(it);
  }

  return {
    items,
    meta,
    feed(text: string): void {
      let changed = false;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let r: Row;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r || typeof r.data !== "object" || r.data === null) continue;
        if (r.kind === "message") onMessage(r);
        else if (r.kind === "part") onPart(r);
        else continue;
        changed = true;
      }
      if (changed) redraw();
    },
  };
}
