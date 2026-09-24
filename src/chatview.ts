// The chat view: one agent as a conversation, the way Cursor's agents or
// opencode desktop show it. Built from the agent's Claude Code transcript
// (chatmodel.ts); the terminal keeps running underneath at its real size, so
// Split and the Terminal switch show the same agent, and the TUI never
// reflows. Messages go in through the same path hand-offs use (sendMessage).

import { marked } from "marked";
import DOMPurify from "dompurify";
import { createChat, type Chat, type ChatItem, type StepItem } from "./chatmodel";
import { claudeTranscript, sendInput, sendMessage } from "./ipc";
import type { Pane } from "./panetypes";

/** What the chat view needs to know about the agent from the inbox. */
export interface ChatState {
  name: string;
  /** "working" shows the working line and Stop; "needs" hides the composer
   *  while the answer card is up. */
  state: string;
}

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

/** Steps between two messages sit together; a long run folds its start. */
function threadHtml(items: ChatItem[], open: Set<string>, expanded: Set<string>): string {
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
}

const views = new Map<string, View>();

function dirOf(pane: Pane): string | null {
  return pane.spec.worktree || pane.spec.cwd || null;
}

function draw(v: View, force = false): void {
  const items = v.chat.items;
  const sig = `${items.length}|${items.filter((i) => i.kind === "step" && i.done).length}|${v.window}|${v.open.size}|${v.expanded.size}|${v.path ? 1 : 0}|${items.length ? "" : v.state.state}`;
  const scroller = v.el.querySelector<HTMLElement>(".cv-scroll")!;
  const thread = v.el.querySelector<HTMLElement>(".cv-thread")!;
  if (sig !== v.sig || force) {
    v.sig = sig;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    const start = Math.max(0, items.length - v.window);
    thread.innerHTML = (start > 0 ? `<button type="button" class="cv-earlier" data-earlier>Show earlier messages</button>` : "") +
      (items.length ? threadHtml(items.slice(start), v.open, v.expanded)
        : `<div class="cv-empty"><b>${esc(v.state.name)}</b><span>${v.state.state === "stopped" ? "Stopped. Start it again to give it a job." : v.path ? "Nothing said yet." : "Starting… the conversation shows up here as soon as it begins."}</span></div>`);
    if (nearBottom || force) scroller.scrollTop = scroller.scrollHeight;
  }
  const working = v.state.state === "working";
  v.el.classList.toggle("working", working);
  v.el.classList.toggle("asking", v.state.state === "needs");
  v.el.classList.toggle("stopped", v.state.state === "stopped");
  const wl = v.el.querySelector<HTMLElement>(".cv-working");
  if (wl) wl.hidden = !working;
}

async function poll(pane: Pane, v: View): Promise<void> {
  if (!pane.el.isConnected) { dropChat(pane.id); return; }
  if (v.busy) return;
  v.busy = true;
  try {
    const dir = dirOf(pane);
    if (!dir) return;
    const since = pane.spawnedAt ? pane.spawnedAt - 5000 : null;
    // Without its own session id, only a transcript begun after this run started
    // can be its own; a stopped agent from an old session shows nothing.
    if (!pane.spec.sessionId && since === null) return;
    for (let k = 0; k < SLICES_PER_TICK; k++) {
      const r = await claudeTranscript(dir, pane.spec.sessionId ?? null, since, v.offset);
      if (r.path && r.path !== v.path) {
        // A new session (the agent restarted): start the conversation over.
        if (v.path) { v.chat = createChat(); v.offset = 0; v.path = r.path; continue; }
        v.path = r.path;
      }
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
    <div class="cv-scroll"><div class="cv-thread" role="log" aria-live="polite"></div></div>
    <div class="cv-foot">
      <p class="cv-working" hidden><span class="cv-dots" aria-hidden="true"><i></i><i></i><i></i></span>Working</p>
      <p class="cv-stopped">Stopped <button type="button" class="cv-restart" data-restart-agent>Start again</button></p>
      <form class="cv-compose">
        <label class="ia-sr" for="cv-in-${pane.id}">Message ${esc(pane.spec.name)}</label>
        <textarea id="cv-in-${pane.id}" rows="1" placeholder="Message ${esc(pane.spec.name)}…"></textarea>
        <div class="cv-bar">
          <span class="cv-hint">Enter to send · Shift+Enter for a new line</span>
          <button type="button" class="cv-stop" data-stop title="Stop what it is doing (Esc)">Stop</button>
          <button type="submit" class="cv-send" aria-label="Send">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
          </button>
        </div>
      </form>
    </div>`;
  host.appendChild(el);
  const v: View = { el, chat: createChat(), offset: 0, path: "", sig: "", window: WINDOW, open: new Set(), expanded: new Set(), timer: null, busy: false, state: { name: pane.spec.name, state: "idle" } };
  const input = el.querySelector<HTMLTextAreaElement>("textarea")!;
  const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; };
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    grow();
    void sendMessage(pane.id, text);
    const scroller = el.querySelector<HTMLElement>(".cv-scroll")!;
    scroller.scrollTop = scroller.scrollHeight;
  };
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    else if (e.key === "Escape" && v.state.state === "working") { e.preventDefault(); void sendInput(pane.id, "\x1b"); }
  });
  el.querySelector("form")!.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    // The pane's own restart button knows how to start this agent again.
    if (t.closest("[data-restart-agent]")) { pane.el.querySelector<HTMLElement>("[data-restart]")?.click(); return; }
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
