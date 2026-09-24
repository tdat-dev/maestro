// The chat view: one agent as a conversation, the way Cursor's agents or
// opencode desktop show it. Built from the agent's Claude Code transcript
// (chatmodel.ts); the terminal keeps running underneath at its real size, so
// Split and the Terminal switch show the same agent, and the TUI never
// reflows. Messages go in through the same path hand-offs use (sendMessage).

import { marked } from "marked";
import DOMPurify from "dompurify";
import { createChat, turnsOf, type Chat, type ChatItem, type StepItem } from "./chatmodel";
import { openMenu } from "./ctxmenu";
import { openPalette, type PaletteItem } from "./inboxpalette";
import { cliFacts, profileOf, type CliFacts } from "./cliprofile";
import { STARTERS } from "./starters";
import { claudeSessions, claudeTranscript, sendInput, sendMessage, type ClaudeSession } from "./ipc";
import type { Pane } from "./panetypes";

/** "3m ago", "2h ago", "Sep 20". */
export function ago(at: number, now = Date.now()): string {
  const m = Math.round((now - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** A Claude command the chat answers itself, because in the CLI it opens a
 *  picker or swaps the session underneath the chat: /resume and /clear. */
export function chatCommand(text: string): { kind: "resume"; query: string } | { kind: "clear" } | null {
  const m = /^\/(resume|clear)\b\s*(.*)$/i.exec(text.trim());
  if (!m) return null;
  return m[1].toLowerCase() === "resume" ? { kind: "resume", query: m[2] } : { kind: "clear" };
}

/** What the chat view needs to know about the agent from the inbox. */
export interface ChatState {
  name: string;
  /** "working" shows the working line and Stop; "needs" hides the composer
   *  while the answer card is up. */
  state: string;
  /** Why it could not start, when it could not. */
  problem?: string;
  /** Its git branch, for the side panel. */
  branch?: string | null;
  /** Open the full Changes view for this agent. */
  onReview?: () => void;
  /** Show this agent's terminal (for the CLI's own pickers). */
  onTerminal?: () => void;
}

/** "claude-opus-5-5" → "Opus 5.5", "Opus 5.5 (1M context)" → "Opus 5.5";
 *  other ids as they are. */
export function modelName(id: string | null): string {
  if (!id) return "";
  if (!id.startsWith("claude-")) return id.replace(/\s*\(.*$/, "");
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** Which of Claude Code's model aliases a model name is: "Opus 5.5 (1M
 *  context)" → "opus", "claude-haiku-4-5-2025" → "haiku", Opus Plan's
 *  "Opus in plan mode, else Sonnet" → "opusplan". Null when unknown. */
export function modelAlias(model: string | null): string | null {
  if (!model) return null;
  const s = model.toLowerCase();
  if (s.includes("opusplan") || /plan mode/.test(s)) return "opusplan";
  for (const a of ["opus", "sonnet", "haiku"]) if (s.includes(a)) return a;
  return null;
}

/** 950 → "950", 45_200 → "45k", 1_300_000 → "1.3M". */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") : Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 12_000 → "12s", 72_000 → "1m 12s", 3_780_000 → "1h 3m". */
export function took(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(1, s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Where a changed file sits: its folder inside the agent's folder
 *  ("src/auth"), "project root", or, outside it, the folder it is in. */
export function whereIn(path: string, root: string | undefined): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = norm(path);
  const r = root ? norm(root) : "";
  const dir = p.slice(0, Math.max(0, p.lastIndexOf("/")));
  if (r && dir.toLowerCase() === r.toLowerCase()) return "project root";
  if (r && dir.toLowerCase().startsWith(r.toLowerCase() + "/")) return dir.slice(r.length + 1);
  return `outside the project · ${dir.split("/").pop() ?? dir}`;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** The last two parts of a path: "src/auth.ts" out of "D:\\app\\src\\auth.ts". */
const tail = (p: string, n = 2) => p.replace(/[\\/]+$/, "").split(/[\\/]/).slice(-n).join("/");

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const POLL_MS = 800;
const WINDOW = 160; // items drawn at once; "Show earlier" widens it
const SLICES_PER_TICK = 12; // a long session loads in a few ticks, not one freeze

/** Agents whose transcript we can read. */
export function chatSupported(pane: Pane): boolean {
  return pane.spec.badge === "claude";
}

const ICON: Record<string, string> = {
  Ran: `<path d="M4 6l4 4-4 4M10 14h6" />`,
  Read: `<path d="M5 3h7l3 3v11H5z" /><path d="M8 9h5M8 12h5" />`,
  Edited: `<path d="M4 16l1-4 8-8 3 3-8 8z" />`,
  Wrote: `<path d="M5 3h7l3 3v11H5z" /><path d="M10 8v6M7 11h6" />`,
  search: `<circle cx="9" cy="9" r="5" /><path d="M13 13l4 4" />`,
  plan: `<path d="M4 6h2M4 10h2M4 14h2M9 6h7M9 10h7M9 14h7" />`,
  agent: `<circle cx="10" cy="7" r="3" /><path d="M4 17c1-3 3.5-4 6-4s5 1 6 4" />`,
  tool: `<path d="M12 4a4 4 0 0 0-4 5l-4 4 3 3 4-4a4 4 0 0 0 5-4l-2 2-2-1-1-2z" />`,
};
function iconFor(s: StepItem): string {
  const k = s.verb in ICON ? s.verb
    : /Search|Looked for|Listed/.test(s.verb) ? "search"
    : s.tool === "TodoWrite" ? "plan"
    : /helper agent/.test(s.verb) ? "agent" : "tool";
  return `<svg class="cv-ic" viewBox="0 0 20 20" aria-hidden="true">${ICON[k]}</svg>`;
}

function markdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: false }) as string);
}

function stepBody(s: StepItem): string {
  if (s.todos?.length) {
    return `<ul class="cv-todos">${s.todos.map((t) => `<li class="${t.state}"><i aria-hidden="true"></i>${esc(t.text)}</li>`).join("")}</ul>`;
  }
  if (s.diff?.length) {
    return `<pre class="cv-diff">${s.diff.map((l) => `<span class="${l.sign === "+" ? "a" : l.sign === "-" ? "d" : ""}">${esc(l.sign)} ${esc(l.text)}</span>`).join("\n")}</pre>`;
  }
  const head = s.full && s.full !== s.target ? `<code class="cv-full">${esc(s.full)}</code>` : "";
  const out = s.output ? `<pre class="cv-out${s.error ? " err" : ""}">${esc(s.output)}</pre>` : s.done ? `<p class="cv-none">No output</p>` : "";
  return head + out;
}

function hasBody(s: StepItem): boolean {
  return !!(s.todos?.length || s.diff?.length || s.output || (s.full && s.full !== s.target));
}

function stepHtml(s: StepItem, open: boolean): string {
  const counts = s.added || s.removed ? `<span class="cv-n"><b class="a">+${s.added ?? 0}</b> <b class="d">−${s.removed ?? 0}</b></span>` : "";
  const state = !s.done ? `<span class="cv-spin" aria-label="Running"></span>` : s.error ? `<span class="cv-err">Failed</span>` : "";
  const body = hasBody(s);
  return `<div class="cv-step${s.error ? " err" : ""}${open ? " open" : ""}" data-id="${s.id}">
    <button type="button" class="cv-sh"${body ? ` aria-expanded="${open}"` : " disabled"} title="${esc(s.full ?? s.target)}">
      ${iconFor(s)}<span class="cv-verb">${esc(s.verb)}</span><span class="cv-tgt${s.code ? " code" : ""}">${esc(s.target)}</span>${counts}${state}
      ${body ? `<svg class="cv-chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2.5 6 5 3.5 7.5" /></svg>` : ""}
    </button>${open && body ? `<div class="cv-sb">${stepBody(s)}</div>` : ""}</div>`;
}

function itemHtml(it: ChatItem, open: Set<string>): string {
  switch (it.kind) {
    case "user":
      return `<div class="cv-u" data-id="${it.id}"><div class="cv-bubble">${esc(it.text)}${it.images ? `<span class="cv-img">${it.images} image${it.images === 1 ? "" : "s"}</span>` : ""}</div></div>`;
    case "text":
      return `<div class="cv-a" data-id="${it.id}">${markdown(it.text)}</div>`;
    case "note":
      return `<div class="cv-note" data-id="${it.id}"><span>${esc(it.text)}</span></div>`;
    case "step":
      return stepHtml(it, open.has(it.id) || (it.tool === "TodoWrite" && !open.has(`!${it.id}`)));
  }
}

/** The conversation by turns: each of your messages, what followed, and for a
 *  finished turn a footer (how long it worked, when, Copy). */
function threadHtml(items: ChatItem[], open: Set<string>, expanded: Set<string>, working: boolean): string {
  const turns = turnsOf(items);
  return turns.map((t, k) => {
    const said = t.items.some((i) => i.kind === "text");
    const done = !(working && k === turns.length - 1);
    const lastAt = t.items[t.items.length - 1]?.at ?? 0;
    const foot = said && done
      ? `<div class="cv-tf">${t.took ? `<span>Worked for ${took(t.took)}</span>` : ""}${lastAt ? `<time>${clock(lastAt)}</time>` : ""}<button type="button" class="cv-copy" data-copy="${t.items[0].id}">Copy</button></div>`
      : "";
    return runsHtml(t.items, open, expanded) + foot;
  }).join("");
}

/** Steps between two messages sit together; a long run folds its start. */
function runsHtml(items: ChatItem[], open: Set<string>, expanded: Set<string>): string {
  let html = "";
  let run: StepItem[] = [];
  const flush = () => {
    if (!run.length) return;
    const key = run[0].id;
    const fold = run.length > 5 && !expanded.has(key);
    const shown = fold ? run.slice(-3) : run;
    html += `<div class="cv-steps">${fold ? `<button type="button" class="cv-more" data-expand="${key}">${run.length - 3} earlier steps</button>` : ""}${shown.map((s) => stepHtml(s, open.has(s.id) || (s.tool === "TodoWrite" && !open.has(`!${s.id}`)))).join("")}</div>`;
    run = [];
  };
  for (const it of items) {
    if (it.kind === "step") { run.push(it); continue; }
    flush();
    html += itemHtml(it, open);
  }
  flush();
  return html;
}

interface View {
  el: HTMLElement;
  chat: Chat;
  offset: number;
  path: string;
  sig: string;
  window: number;
  open: Set<string>;
  expanded: Set<string>;
  timer: number | null;
  busy: boolean;
  state: ChatState;
  pane: Pane;
  sideSig: string;
  /** What the CLI said about itself (its commands, its model). */
  facts?: CliFacts;
  /** The Claude session this view shows; another one means another conversation. */
  session?: string;
  /** Earlier conversations in its folder, newest first (asked now and then). */
  sessions?: ClaudeSession[];
  sessionsAt?: number;
}

const views = new Map<string, View>();

/** The folder this agent's CLI was started in; pane.ts writes it at boot. */
function dirOf(pane: Pane): string | null {
  return pane.spec.ranIn ?? null;
}

/** The panel beside the conversation: the plan, the files it changed, and
 *  the session (model, branch, folder, when, how much context). */
function sideHtml(v: View): string {
  const m = v.chat.meta;
  const s = v.state;
  let html = "";
  if (m.todos?.length) {
    const done = m.todos.filter((t) => t.state === "completed").length;
    html += `<section class="cs-sec" aria-label="Plan"><h3>Plan <span>${done} of ${m.todos.length}</span></h3>
      <div class="cs-bar" aria-hidden="true"><i style="width:${Math.round((done / m.todos.length) * 100)}%"></i></div>
      <ul class="cv-todos cs-todos">${m.todos.map((t) => `<li class="${t.state}"><i aria-hidden="true"></i>${esc(t.text)}</li>`).join("")}</ul></section>`;
  }
  if (m.files.length) {
    const add = m.files.reduce((n, f) => n + f.added, 0);
    const del = m.files.reduce((n, f) => n + f.removed, 0);
    html += `<section class="cs-sec" aria-label="Files changed"><h3>Files changed <span>${m.files.length} · <b class="a">+${add}</b> <b class="d">−${del}</b></span></h3>
      <ul class="cs-files">${m.files.map((f) => `<li><button type="button" ${s.onReview ? "data-review" : "disabled"} title="${esc(f.path)}"><span class="cs-fn">${esc(f.name)}</span><span class="cs-fd">${esc(whereIn(f.path, v.pane.spec.ranIn))}</span><span class="cv-n"><b class="a">+${f.added}</b> <b class="d">−${f.removed}</b></span></button></li>`).join("")}</ul>
      ${s.onReview ? `<button type="button" class="cs-review" data-review>Review changes</button>` : ""}</section>`;
  }
  const others = (v.sessions ?? []).filter((x) => x.id !== v.pane.spec.sessionId).slice(0, 5);
  if (others.length) {
    html += `<section class="cs-sec" aria-label="Earlier conversations"><h3>Earlier conversations <span>${v.sessions!.length}</span></h3>
      <ul class="cs-convos">${others.map((x) => `<li><button type="button" data-resume="${esc(x.id)}" title="Resume this conversation"><span class="cs-ct">${esc(x.title || "Untitled")}</span><span class="cs-cm">${x.messages} message${x.messages === 1 ? "" : "s"} · ${ago(x.modified_ms)}</span></button></li>`).join("")}</ul>
      ${v.sessions!.length > others.length + 1 ? `<button type="button" class="cs-review" data-resume-pick>All conversations</button>` : ""}</section>`;
  }
  const rows: Array<[string, string]> = [
    ["Model", modelName(m.model)],
    ["Branch", s.branch ?? ""],
    ["Folder", v.pane.spec.ranIn ? tail(v.pane.spec.ranIn, 1) : ""],
    ["Started", m.started ? clock(m.started) : ""],
    ["Context", m.context ? `${tokens(m.context)} tokens` : ""],
    ["Written", m.output ? `${tokens(m.output)} tokens` : ""],
  ].filter((r): r is [string, string] => !!r[1]);
  html += `<section class="cs-sec" aria-label="Session"><h3>Session</h3>${rows.length
    ? `<dl class="cs-dl">${rows.map(([k, val]) => `<div><dt>${k}</dt><dd>${esc(val)}</dd></div>`).join("")}</dl>`
    : `<p class="cs-none">Details show up once it starts talking.</p>`}</section>`;
  return html;
}

function draw(v: View, force = false): void {
  const items = v.chat.items;
  const sig = `${items.length}|${items.filter((i) => i.kind === "step" && i.done).length}|${v.window}|${v.open.size}|${v.expanded.size}|${v.path ? 1 : 0}|${items.length ? "" : v.state.state + (v.state.problem ?? "")}`;
  const scroller = v.el.querySelector<HTMLElement>(".cv-scroll")!;
  const thread = v.el.querySelector<HTMLElement>(".cv-thread")!;
  if (sig !== v.sig || force) {
    v.sig = sig;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    const start = Math.max(0, items.length - v.window);
    const quiet = v.state.problem || v.state.state === "stopped";
    thread.innerHTML = (start > 0 ? `<button type="button" class="cv-earlier" data-earlier>Show earlier messages</button>` : "") +
      (items.length ? threadHtml(items.slice(start), v.open, v.expanded, v.state.state === "working")
        : `<div class="cv-empty"><b>${quiet ? esc(v.state.name) : `What should ${esc(v.state.name)} do?`}</b><span>${v.state.problem ? esc(v.state.problem) : v.state.state === "stopped" ? "Stopped. Start it again to give it a job." : "Say it in your own words below, or start from one of these."}</span>
          ${quiet ? "" : `<div class="cv-starters">${STARTERS.map((s) => `<button type="button" data-starter="${esc(s.job)}">${esc(s.label)}</button>`).join("")}</div>`}</div>`);
    if (nearBottom || force) scroller.scrollTop = scroller.scrollHeight;
  }
  const working = v.state.state === "working";
  v.el.classList.toggle("working", working);
  v.el.classList.toggle("asking", v.state.state === "needs");
  v.el.classList.toggle("stopped", v.state.state === "stopped");
  const wl = v.el.querySelector<HTMLElement>(".cv-working");
  if (wl) wl.hidden = !working;
  // the composer's model and context, the side panel
  const m = v.chat.meta;
  const model = v.el.querySelector<HTMLElement>(".cv-model");
  if (model) {
    const name = modelName(m.model ?? v.facts?.model ?? null);
    model.textContent = name ? `${name} ▾` : "Model ▾";
    model.hidden = !profileOf(v.pane.spec.badge).modelCommand;
  }
  const ctx = v.el.querySelector<HTMLElement>(".cv-ctx");
  if (ctx) { ctx.textContent = m.context ? `${tokens(m.context)} in context` : ""; ctx.hidden = !m.context; }
  const sideSig = JSON.stringify([m.todos, m.files, m.model, m.context, m.output, m.started, v.state.branch, !!v.state.onReview, v.pane.spec.ranIn, v.sessions?.map((x) => x.id + x.modified_ms), v.pane.spec.sessionId]);
  if (sideSig !== v.sideSig) {
    v.sideSig = sideSig;
    const side = v.el.querySelector<HTMLElement>(".cv-side");
    if (side) side.innerHTML = sideHtml(v);
  }
}

/** The view follows the agent's session: a new conversation (/clear, New
 *  conversation) or another one (/resume) starts the view over at once, even
 *  before the new session has written anything. */
function follow(pane: Pane, v: View): boolean {
  const id = pane.spec.sessionId;
  if (id === v.session) return false;
  v.session = id;
  v.chat = createChat();
  v.offset = 0;
  v.path = "";
  v.sig = "";
  v.sideSig = "";
  v.open.clear();
  v.expanded.clear();
  v.window = WINDOW;
  return true;
}

async function poll(pane: Pane, v: View): Promise<void> {
  if (!pane.el.isConnected) { dropChat(pane.id); return; }
  follow(pane, v);
  const dir0 = dirOf(pane);
  if (dir0 && (!v.sessionsAt || Date.now() - v.sessionsAt > 30_000)) {
    v.sessionsAt = Date.now();
    void claudeSessions(dir0).then((s) => { v.sessions = s; draw(v); }).catch(() => {});
  }
  if (v.busy) return;
  v.busy = true;
  try {
    const dir = dirOf(pane);
    if (!dir) return;
    const since = pane.spawnedAt ? pane.spawnedAt - 5000 : null;
    // Without its own session id, only a transcript begun after this run started
    // can be its own; a stopped agent from an old session shows nothing.
    if (!pane.spec.sessionId && since === null) return;
    const session = pane.spec.sessionId;
    for (let k = 0; k < SLICES_PER_TICK; k++) {
      const r = await claudeTranscript(dir, session ?? null, since, v.offset);
      // Without a session id of its own (a preset that picks one), a new file
      // is the only sign of a new conversation.
      if (r.path && r.path !== v.path) {
        if (v.path) { v.chat = createChat(); v.offset = 0; v.path = r.path; v.sig = ""; continue; }
        v.path = r.path;
      }
      if (session !== pane.spec.sessionId) return; // switched while reading: next tick
      if (!r.text) break;
      v.chat.feed(r.text);
      v.offset = r.next;
    }
  } catch { /* the next tick tries again */ } finally {
    v.busy = false;
  }
  if (views.get(pane.id) === v) draw(v);
}

function mount(pane: Pane): View {
  const host = pane.el.querySelector<HTMLElement>(".term-host") ?? pane.el;
  const el = document.createElement("section");
  el.className = "cv";
  el.setAttribute("aria-label", `Conversation with ${pane.spec.name}`);
  el.innerHTML = `
    <div class="cv-main">
    <div class="cv-scroll"><div class="cv-thread" role="log" aria-live="polite"></div></div>
    <div class="cv-foot">
      <p class="cv-working" hidden><span class="cv-dots" aria-hidden="true"><i></i><i></i><i></i></span>Working</p>
      <p class="cv-stopped">Stopped <button type="button" class="cv-restart" data-restart-agent>Resume</button><button type="button" class="cv-new" data-new-convo>New conversation</button></p>
      <form class="cv-compose">
        <label class="ia-sr" for="cv-in-${pane.id}">Message ${esc(pane.spec.name)}</label>
        <textarea id="cv-in-${pane.id}" rows="1" placeholder="Message ${esc(pane.spec.name)}…  Enter to send, Shift+Enter for a new line"></textarea>
        <div class="cv-bar">
          <button type="button" class="cv-chip cv-model" data-model title="Change the model" hidden></button>
          <button type="button" class="cv-chip cv-cmds" data-cmds title="Claude Code commands">/ Commands</button>
          <span class="cv-ctx" title="How much the agent is holding in mind right now" hidden></span>
          <span class="cv-sp"></span>
          <button type="button" class="cv-stop" data-stop title="Stop what it is doing (Esc)">Stop</button>
          <button type="submit" class="cv-send" aria-label="Send">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
          </button>
        </div>
      </form>
    </div>
    </div>
    <aside class="cv-side" aria-label="About this conversation"></aside>`;
  host.appendChild(el);
  const v: View = { el, chat: createChat(), offset: 0, path: "", sig: "", window: WINDOW, open: new Set(), expanded: new Set(), timer: null, busy: false, state: { name: pane.spec.name, state: "idle" }, pane, sideSig: "" };
  const input = el.querySelector<HTMLTextAreaElement>("textarea")!;
  const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; };
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    const own = chatCommand(text);
    if (own) {
      input.value = "";
      grow();
      if (own.kind === "resume") void pickConversation(own.query);
      else void pane.restart?.({ fresh: true });
      return;
    }
    input.value = "";
    grow();
    void sendMessage(pane.id, text);
    const scroller = el.querySelector<HTMLElement>(".cv-scroll")!;
    scroller.scrollTop = scroller.scrollHeight;
  };
  input.addEventListener("input", grow);
  /** Claude's conversations in this folder; picking one resumes it here
   *  (claude --resume <id>), so the chat knows which conversation it shows. */
  const pickConversation = async (query: string) => {
    const dir = pane.spec.ranIn ?? pane.spec.cwd;
    if (!dir) return;
    try { v.sessions = await claudeSessions(dir); v.sessionsAt = Date.now(); } catch { v.sessions = v.sessions ?? []; }
    const items: PaletteItem[] = (v.sessions ?? []).map((x) => ({
      group: x.id === pane.spec.sessionId ? "This conversation" : "Conversations",
      label: x.title || "Untitled",
      sub: `${x.messages} message${x.messages === 1 ? "" : "s"} · ${ago(x.modified_ms)}`,
      run: () => { if (x.id !== pane.spec.sessionId || !pane.running) void pane.restart?.({ session: x.id }); },
    }));
    if (!items.length) items.push({ group: "Conversations", label: "No earlier conversations in this folder", run: () => {} });
    openPalette(items, { placeholder: query ? `Resume a conversation: ${query}` : "Resume a conversation" });
    const q = document.getElementById("palQ") as HTMLInputElement | null;
    if (q && query) { q.value = query; q.dispatchEvent(new Event("input", { bubbles: true })); }
  };
  /** The CLI's own commands, searchable; the pick goes into the composer. */
  const pickCommand = async (query = "") => {
    const btn = el.querySelector<HTMLButtonElement>("[data-cmds]");
    const asked = cliFacts(pane.spec.badge, pane.spec.program, pane.spec.ranIn ?? pane.spec.cwd);
    if (!asked) return;
    if (btn) btn.textContent = "Loading…";
    try {
      v.facts = await asked;
    } catch (e) {
      if (btn) btn.textContent = "/ Commands";
      openMenu(btn?.getBoundingClientRect().left ?? 0, (btn?.getBoundingClientRect().top ?? 0) - 8,
        [{ label: "Couldn't list its commands", hint: String((e as { Failed?: string })?.Failed ?? e).slice(0, 60), disabled: true, run: () => {} }], "Commands");
      return;
    }
    if (btn) btn.textContent = "/ Commands";
    const group = { command: "Commands", skill: "Skills", plugin: "Plugins" } as const;
    const listed = new Set(v.facts.commands.map((c) => c.name));
    const mine = (["resume", "clear"] as const).filter((n) => !listed.has(n)).map((n) => ({ name: n, kind: "command" as const }));
    const items: PaletteItem[] = [...mine, ...v.facts.commands].map((c) => ({
      group: group[c.kind], label: `/${c.name}`,
      run: () => { input.value = `/${c.name} `; grow(); input.focus(); },
    }));
    openPalette(items, { placeholder: `${v.facts.commands.length} commands from ${pane.spec.name}'s CLI${query ? "" : ": type to search"}` });
  };
  // Warm the list up, so the first / opens at once.
  void cliFacts(pane.spec.badge, pane.spec.program, pane.spec.ranIn ?? pane.spec.cwd)?.then((f) => { v.facts = f; draw(v); }).catch(() => {});
  input.addEventListener("keydown", (e) => {
    if (e.key === "/" && !input.value && cliFacts(pane.spec.badge, pane.spec.program, pane.spec.ranIn ?? pane.spec.cwd)) { e.preventDefault(); void pickCommand(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    else if (e.key === "Escape" && v.state.state === "working") { e.preventDefault(); void sendInput(pane.id, "\x1b"); }
  });
  el.querySelector("form")!.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    // The pane's own restart button knows how to start this agent again.
    if (t.closest("[data-restart-agent]")) { void pane.restart?.(); return; }
    if (t.closest("[data-new-convo]")) { void pane.restart?.({ fresh: true }); return; }
    const resumeOne = t.closest<HTMLElement>("[data-resume]");
    if (resumeOne) { void pane.restart?.({ session: resumeOne.dataset.resume }); return; }
    if (t.closest("[data-resume-pick]")) { void pickConversation(""); return; }
    const starter = t.closest<HTMLElement>("[data-starter]");
    if (starter) { input.value = starter.dataset.starter ?? ""; grow(); input.focus(); return; }
    const cmds = t.closest<HTMLButtonElement>("[data-cmds]");
    if (cmds) { void pickCommand(); return; }
    const modelBtn = t.closest<HTMLElement>("[data-model]");
    if (modelBtn) {
      const p = profileOf(pane.spec.badge);
      if (!p.modelCommand) return;
      const r = modelBtn.getBoundingClientRect();
      // Only what this conversation itself says is in use; every model stays
      // pickable (choosing the one in use again is harmless).
      const inUse = modelAlias(v.chat.meta.model);
      openMenu(r.left, r.top - 8, [
        ...(p.models ?? []).map((m) => ({
          label: m.label, hint: m.value === inUse ? "In use" : m.hint,
          // The CLI switches itself: the same command you would type. It also
          // saves it as the default, so what we asked the CLI earlier is stale.
          run: () => {
            void sendMessage(pane.id, `${p.modelCommand} ${m.value}`);
            void cliFacts(pane.spec.badge, pane.spec.program, pane.spec.ranIn ?? pane.spec.cwd, true)?.then((f) => { v.facts = f; }).catch(() => {});
          },
        })),
        { label: "More in the terminal…", sep: true, hint: "Its own picker", run: () => { v.state.onTerminal?.(); void sendMessage(pane.id, p.modelCommand!); } },
      ], "Model");
      return;
    }
    const copy = t.closest<HTMLElement>("[data-copy]");
    if (copy) {
      const turn = turnsOf(v.chat.items).find((x) => x.items[0]?.id === copy.dataset.copy);
      const text = turn?.items.filter((i) => i.kind === "text").map((i) => ("text" in i ? i.text : "")).join("\n\n") ?? "";
      void navigator.clipboard?.writeText(text).then(() => { copy.textContent = "Copied"; window.setTimeout(() => { copy.textContent = "Copy"; }, 1400); }).catch(() => {});
      return;
    }
    if (t.closest("[data-review]")) { v.state.onReview?.(); return; }
    if (t.closest("[data-stop]")) { void sendInput(pane.id, "\x1b"); return; }
    if (t.closest("[data-earlier]")) { v.window += WINDOW; draw(v, false); return; }
    const more = t.closest<HTMLElement>("[data-expand]");
    if (more) { v.expanded.add(more.dataset.expand!); draw(v); return; }
    const head = t.closest<HTMLElement>(".cv-sh");
    const step = head?.closest<HTMLElement>(".cv-step");
    if (step && !head!.hasAttribute("disabled")) {
      const id = step.dataset.id!;
      const isTodo = v.chat.items.find((i) => i.id === id && i.kind === "step" && i.tool === "TodoWrite");
      const openNow = step.classList.contains("open");
      if (isTodo) { if (openNow) v.open.delete(id), v.open.add(`!${id}`); else v.open.delete(`!${id}`), v.open.add(id); }
      else if (openNow) v.open.delete(id); else v.open.add(id);
      draw(v);
    }
  });
  // Keys typed in the conversation go to the composer, not the hidden terminal.
  el.addEventListener("keydown", (e) => e.stopPropagation());
  views.set(pane.id, v);
  return v;
}

/** Show the conversation over this pane's terminal and keep it current. */
export function showChat(pane: Pane, state: ChatState, focus = false): void {
  const v = views.get(pane.id) ?? mount(pane);
  v.state = state;
  // another conversation: read it now rather than at the next tick
  if (follow(pane, v) && v.timer !== null) void poll(pane, v);
  pane.el.classList.add("chat-on");
  if (v.timer === null) {
    v.timer = window.setInterval(() => void poll(pane, v), POLL_MS);
    void poll(pane, v).then(() => draw(v, true));
  }
  draw(v);
  if (focus) requestAnimationFrame(() => requestAnimationFrame(() => v.el.querySelector<HTMLTextAreaElement>("textarea")?.focus()));
}

/** Back to the terminal (Split, the Terminal switch, or another agent on stage). */
export function hideChat(pane: Pane): void {
  pane.el.classList.remove("chat-on");
  const v = views.get(pane.id);
  if (v && v.timer !== null) { window.clearInterval(v.timer); v.timer = null; }
}

/** Forget a pane's view (the pane was removed). */
export function dropChat(paneId: string): void {
  const v = views.get(paneId);
  if (v?.timer != null) window.clearInterval(v.timer);
  v?.el.remove();
  views.delete(paneId);
}

export function chatShown(pane: Pane): boolean {
  return pane.el.classList.contains("chat-on");
}
