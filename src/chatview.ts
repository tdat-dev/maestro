// The chat view: one agent as a conversation, the way Cursor's agents or
// opencode desktop show it. Built from the agent's Claude Code transcript
// (chatmodel.ts); the terminal keeps running underneath at its real size, so
// Split and the Terminal switch show the same agent, and the TUI never
// reflows. Messages go in through the same path hand-offs use (sendMessage).

import { marked } from "marked";
import DOMPurify from "dompurify";
import { createChat, turnsOf, type BgTask, type Chat, type ChatImage, type ChatItem, type FileChange, type StepItem } from "./chatmodel";
import { ICON_CLOSE } from "./icons";
import { openFileInPanel } from "./agentbridge";
import { openMenu } from "./ctxmenu";
import { openPalette, type PaletteItem } from "./inboxpalette";
import { cliFacts, profileOf, type CliChoice, type CliFacts } from "./cliprofile";
import { STARTERS } from "./starters";
import { sourceOf } from "./chatsource";
import { applyMention, mentionAt, mentionMatches, withFolders, type MentionHit } from "./mention";
import { claudeSessions, claudeSessionsEverywhere, fsReadDataUrl, fsReadFile, pickFiles, savePastedFile, workspaceFiles, openExternal, savePastedImage, sendInput, sendMessage, type ClaudeSession } from "./ipc";
import { confirmModal } from "./confirmmodal";
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
  /** "working" shows the working line and Stop; "stopped" offers Resume. */
  state: string;
  /** Why it could not start, when it could not. */
  problem?: string;
  /** The answer card is up over the stage: it is the way to reply, so the
   *  composer steps aside and the end of the conversation stays above it. */
  asking?: boolean;
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
/** The time for today, the day and time before that. */
export function when(at: number, now = Date.now()): string {
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) return clock(at);
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock(at)}`;
}
/** The same folder, however its slashes and letter case are written. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
/** A tooltip's worth of a long value: its first line, cut short. */
const brief = (s: string) => { const line = s.split(/\r?\n/)[0]; return line.length > 200 ? `${line.slice(0, 199)}…` : line; };
/** The last two parts of a path: "src/auth.ts" out of "D:\\app\\src\\auth.ts". */
const tail = (p: string, n = 2) => p.replace(/[\\/]+$/, "").split(/[\\/]/).slice(-n).join("/");

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const POLL_MS = 800;
const WINDOW = 160; // items drawn at once; "Show earlier" widens it
const SLICES_PER_TICK = 12; // a long session loads in a few ticks, not one freeze

/** Agents whose transcript we can read. */
export function chatSupported(pane: Pane): boolean {
  return !!sourceOf(pane);
}

/** An empty conversation read the way this agent's CLI writes it. */
function newChat(pane: Pane): Chat {
  return sourceOf(pane)?.createChat() ?? createChat();
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
  shot: `<path d="M3 7h3l1.5-2h5L14 7h3v9H3z" /><circle cx="10" cy="11.5" r="2.8" />`,
  image: `<rect x="3" y="4" width="14" height="12" rx="2" /><circle cx="7.5" cy="8.5" r="1.3" /><path d="M3 14l4-3.5 3 2.5 3-2.5 4 3.5" />`,
  ask: `<path d="M4 5h12v8H9l-3 3v-3H4z" /><path d="M8.5 7.8a1.6 1.6 0 1 1 2.2 1.5c-.5.2-.7.5-.7 1" /><path d="M10 11.6v.1" />`,
};
function iconFor(s: StepItem): string {
  const k = s.verb in ICON ? s.verb
    : s.verb === "Took a screenshot" ? "shot"
    : s.verb === "Looked at" ? "image"
    : s.tool === "AskUserQuestion" ? "ask"
    : /Search|Looked for|Listed/.test(s.verb) ? "search"
    : s.tool === "TodoWrite" ? "plan"
    : /helper agent/.test(s.verb) ? "agent" : "tool";
  return `<svg class="cv-ic" viewBox="0 0 20 20" aria-hidden="true">${ICON[k]}</svg>`;
}

// Parsing markdown is the costly part of a redraw; a message never changes once
// written, so each is parsed once.
const mdCache = new Map<string, string>();
function markdown(id: string, text: string): string {
  const key = `${id}:${text.length}`;
  let html = mdCache.get(key);
  if (html === undefined) {
    if (mdCache.size > 4000) mdCache.clear();
    const t = document.createElement("template");
    t.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: false }) as string);
    // Links say where they go; a click opens them in the browser (see mount),
    // never in the app's own window.
    for (const a of t.content.querySelectorAll("a[href]")) { a.setAttribute("rel", "noopener noreferrer"); a.setAttribute("title", a.getAttribute("href")!); }
    // A code block copies with one click.
    for (const pre of t.content.querySelectorAll("pre")) pre.insertAdjacentHTML("beforeend", `<button type="button" class="cv-cc" data-copy-code aria-label="Copy this code">Copy</button>`);
    // A file named in the answer (`src/app.ts:42`) opens in the code panel.
    for (const code of t.content.querySelectorAll("code")) {
      if (code.closest("pre")) continue;
      const ref = fileRef(code.textContent ?? "");
      if (ref) { code.classList.add("cv-fref"); code.setAttribute("data-file-ref", ref.path); code.setAttribute("title", `Open ${ref.path}`); code.setAttribute("tabindex", "0"); code.setAttribute("role", "link"); }
    }
    html = t.innerHTML;
    mdCache.set(key, html);
  }
  return html;
}

/** A file path in an answer's inline code: `src/app.ts`, `D:\x\y.rs:12`, `chatview.ts:40:3`. */
export function fileRef(text: string): { path: string; line?: number } | null {
  const m = /^((?:[A-Za-z]:[\\/])?[\w.@()[\]\-\\/]*[\w\-]\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?::\d+)?)?$/.exec(text.trim());
  if (!m) return null;
  const path = m[1];
  // a version (1.2.3), a domain (example.com) or a method call (x.map) is not a file
  if (/^\d/.test(path) || /^(?:www\.|[a-z]+\.(?:com|org|net|io|dev|app)$)/i.test(path)) return null;
  if (!/[\\/]/.test(path) && !/\.(?:[jt]sx?|mjs|cjs|rs|py|go|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|css|scss|html|vue|svelte|json|toml|ya?ml|md|txt|sh|ps1|sql|lock|env)$/i.test(path)) return null;
  return { path, line: m[2] ? Number(m[2]) : undefined };
}

const urls = new WeakMap<ChatImage, string>();
/** A picture already held as an object URL (one you pasted), for the full-size view. */
function pictureAt(url: string, media: string): ChatImage {
  const pic: ChatImage = { media, data: "" };
  urls.set(pic, url);
  return pic;
}
/** A URL an <img> can show this picture from. */
function urlOf(img: ChatImage): string {
  let u = urls.get(img);
  if (u) return u;
  try {
    const bin = atob(img.data.replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    u = URL.createObjectURL(new Blob([bytes], { type: img.media }));
  } catch {
    u = `data:${img.media};base64,${img.data}`;
  }
  urls.set(img, u);
  return u;
}
/** Let go of the pictures of a conversation the view no longer shows. */
function forgetImages(items: ChatItem[]): void {
  for (const it of items) {
    const pics = it.kind === "step" ? it.images : it.kind === "user" ? it.pics : undefined;
    for (const p of pics ?? []) {
      const u = urls.get(p);
      if (u?.startsWith("blob:")) URL.revokeObjectURL(u);
      urls.delete(p);
    }
  }
}

const MENTION_FILE = `<svg class="cv-mi" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></svg>`;
const MENTION_FOLDER = `<svg class="cv-mi" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z" /></svg>`;

/** A picture pasted into the composer: shown at once, saved to a file meanwhile. */
interface Attachment { url: string; pic: ChatImage; path: Promise<string | null>; failed?: boolean }
const MAX_ATTACHMENTS = 8;
const PASTE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** The pictures on a clipboard (a screenshot, a copied image or image file). */
export function pastedImages(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file" || !PASTE_TYPES[item.type]) continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

async function base64Of(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function savePasted(f: File): Promise<string> {
  return savePastedImage(await base64Of(f), PASTE_TYPES[f.type] ?? "png");
}

/** Every file on the clipboard: a screenshot, or files copied in Explorer. */
export function pastedFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

/** A path that is a picture the chat can attach. */
const PICTURE_PATH = /\.(png|jpe?g|gif|webp)$/i;
const mediaOf = (path: string) => {
  const ext = (/\.([a-z]+)$/i.exec(path)?.[1] ?? "png").toLowerCase();
  return ext === "jpg" ? "image/jpeg" : `image/${ext}`;
};

/** How a file goes into a message: @path, relative inside the agent's folder, quoted when it has spaces. */
export function fileMention(path: string, dir?: string | null): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  let p = norm(path);
  const d = dir ? norm(dir) : "";
  if (d && p.toLowerCase().startsWith(d.toLowerCase() + "/")) p = p.slice(d.length + 1);
  return /\s/.test(p) ? `@"${p}"` : `@${p}`;
}

/** Most a small picture is blown up: past this it is only blur. */
const MAX_GROW = 3;
/** The size to show a w×h picture at so a small one fills its box (up to
 *  MAX_GROW times its size); null when it is big enough already (CSS shrinks
 *  big ones to fit). */
export function grownSize(w: number, h: number, boxW: number, boxH: number): { w: number; h: number } | null {
  if (!(w > 0 && h > 0 && boxW > 0 && boxH > 0)) return null;
  const s = Math.min(boxW / w, boxH / h, MAX_GROW);
  return s > 1.05 ? { w: Math.round(w * s), h: Math.round(h * s) } : null;
}
/** Thumbnails: one alone gets the big box, several share smaller ones (as the CSS says). */
function fitShot(img: HTMLImageElement): void {
  const many = !!img.closest(".cv-shots")?.querySelector(".cv-shot + .cv-shot");
  const size = grownSize(img.naturalWidth, img.naturalHeight, many ? 220 : 420, many ? 150 : 240);
  img.style.width = size ? `${size.w}px` : "";
  img.style.height = size ? `${size.h}px` : "";
}

/** What a step saw (its screenshots), or what you pasted: thumbnails that open full size. */
function shotsHtml(owner: string, pics: ChatImage[], what: string): string {
  return `<div class="cv-shots">${pics.map((p, k) => `<button type="button" class="cv-shot" data-shot="${owner}" data-k="${k}" aria-label="${what} ${k + 1} of ${pics.length}, open full size"><img src="${urlOf(p)}" alt="" decoding="async"></button>`).join("")}</div>`;
}

function stepBody(s: StepItem): string {
  if (s.todos?.length) {
    return `<ul class="cv-todos">${s.todos.map((t) => `<li class="${t.state}"><i aria-hidden="true"></i>${esc(t.text)}</li>`).join("")}</ul>`;
  }
  if (s.diff?.length) {
    // Each line is its own block: no newline between them, or every line doubles.
    return `<pre class="cv-diff">${s.diff.map((l) => `<span class="${l.sign === "+" ? "a" : l.sign === "-" ? "d" : ""}">${esc(l.sign)} ${esc(l.text)}</span>`).join("")}</pre>`;
  }
  const head = s.full && s.full !== s.target ? `<code class="cv-full">${esc(s.full)}</code>` : "";
  const out = s.output ? `<pre class="cv-out${s.error ? " err" : ""}">${esc(s.output)}</pre>` : s.done && !s.images?.length ? `<p class="cv-none">No output</p>` : "";
  return head + out;
}

function hasBody(s: StepItem): boolean {
  return !!(s.todos?.length || s.diff?.length || s.output || (s.full && s.full !== s.target));
}

function stepHtml(s: StepItem, open: boolean): string {
  const counts = s.added || s.removed ? `<span class="cv-n"><b class="a">+${s.added ?? 0}</b> <b class="d">−${s.removed ?? 0}</b></span>` : "";
  const state = !s.done ? `<span class="cv-spin" role="img" aria-label="Running"></span>` : s.error ? `<span class="cv-err">Failed</span>` : "";
  const body = hasBody(s);
  const inner = `${iconFor(s)}<span class="cv-verb">${esc(s.verb)}</span><span class="cv-tgt${s.code ? " code" : ""}">${esc(s.target)}</span>${counts}${state}`;
  const title = esc(brief(s.full ?? s.target));
  // A step with nothing more to show is a plain line, not a dead button.
  return `<div class="cv-step${s.error ? " err" : ""}${open ? " open" : ""}" data-id="${s.id}">${body
    ? `<button type="button" class="cv-sh" aria-expanded="${open}" title="${title}">${inner}<svg class="cv-chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2.5 6 5 3.5 7.5" /></svg></button>`
    : `<div class="cv-sh cv-flat" title="${title}">${inner}</div>`}${open && body ? `<div class="cv-sb">${stepBody(s)}</div>` : ""}${s.images?.length ? shotsHtml(s.id, s.images, s.verb === "Took a screenshot" ? "Screenshot" : "Image") : ""}</div>`;
}

function itemHtml(it: ChatItem, open: Set<string>): string {
  switch (it.kind) {
    case "user":
      return `<div class="cv-u" data-id="${it.id}"><div class="cv-bubble">${it.pics?.length ? shotsHtml(it.id, it.pics, "Image") : ""}${esc(it.text)}${it.images && !it.pics?.length ? `<span class="cv-img">${it.images} image${it.images === 1 ? "" : "s"}</span>` : ""}</div></div>`;
    case "text":
      return `<div class="cv-a" data-id="${it.id}">${markdown(it.id, it.text)}</div>`;
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
      ? `<div class="cv-tf">${t.took ? `<span>Worked for ${took(t.took)}</span>` : ""}${lastAt ? `<time>${when(lastAt)}</time>` : ""}<button type="button" class="cv-copy" data-copy="${t.items[0].id}" aria-label="Copy this answer">Copy</button></div>`
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
    const long = run.length > 5;
    const fold = long && !expanded.has(key);
    const shown = fold ? run.slice(-3) : run;
    const toggle = !long ? ""
      : fold ? `<button type="button" class="cv-more" data-expand="${key}" aria-expanded="false">${run.length - 3} earlier steps</button>`
      : `<button type="button" class="cv-more" data-fold="${key}" aria-expanded="true">Fold ${run.length - 3} earlier steps</button>`;
    html += `<div class="cv-steps">${toggle}${shown.map((s) => stepHtml(s, open.has(s.id) || (s.tool === "TodoWrite" && !open.has(`!${s.id}`)))).join("")}</div>`;
    run = [];
  };
  for (const it of items) {
    // A question to you is part of the conversation, never folded away with the steps.
    if (it.kind === "step" && it.questions?.length) { flush(); html += askHtml(it); continue; }
    if (it.kind === "step") { run.push(it); continue; }
    flush();
    html += itemHtml(it, open);
  }
  flush();
  return html;
}

/** What the agent asked you (AskUserQuestion): the question, its options with
 *  what each means, and what you picked, or that it waits for you. */
function askHtml(s: StepItem): string {
  const waiting = !s.done;
  const turnedDown = s.done && s.error;
  const qs = (s.questions ?? []).map((q) => {
    const picked = new Set((q.answer ?? "").split(/,\s*/).filter(Boolean));
    const ownWords = q.answer && !q.options.some((o) => picked.has(o.label)) ? q.answer : "";
    return `<section class="cv-q">${q.header ? `<span class="cv-qh">${esc(q.header)}</span>` : ""}<p class="cv-qt">${esc(q.question)}</p>
      <ul class="cv-qo${q.multi ? " multi" : ""}">${q.options.map((o) => {
        const on = picked.has(o.label);
        return `<li${on ? ` class="on"` : ""}><span class="cv-qm" aria-hidden="true"></span><span class="cv-ql"><b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ""}</span>${on ? `<span class="ia-sr">(your answer)</span>` : ""}</li>`;
      }).join("")}</ul>${ownWords ? `<p class="cv-qa">You answered: ${esc(ownWords)}</p>` : ""}</section>`;
  }).join("");
  const note = waiting ? `<p class="cv-qs wait"><span class="cv-dots" aria-hidden="true"><i></i><i></i><i></i></span>Waiting for your answer: pick it in the answer card, or in the terminal.</p>`
    : turnedDown ? `<p class="cv-qs">You chose to talk it over instead of picking.</p>` : "";
  return `<div class="cv-ask${waiting ? " waiting" : ""}" data-id="${s.id}" role="group" aria-label="${esc(s.verb)} ${esc(s.target)}">
    <div class="cv-ask-h">${iconFor(s)}<span>${waiting ? "Asks you" : "Asked you"}</span></div>${qs}${note}</div>`;
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
  /** The first read of the conversation has come back (until then: Loading). */
  loaded: boolean;
  /** A redraw waiting for the text you are selecting to be let go. */
  held: boolean;
  /** The last answer read out to a screen reader. */
  said: string;
  /** Undo what mount hooked onto the document. */
  off?: () => void;
  /** A setting you just changed, shown until the CLI confirms it. */
  pending: Partial<Record<"effort" | "permission", { id: string; at: number }>>;
  /** The work panel's tab you picked (else it follows the work), and what is picked in it. */
  panelTab?: PanelTab;
  selFile?: string;
  selTask?: string;
  /** Background commands' output as last read, and those being read. */
  taskOut: Map<string, string>;
  reading: Set<string>;
  /** New messages came while you were reading further up. */
  unseen: boolean;
  seenItems: number;
  /** Runs after the thread is drawn again (find marks its matches anew). */
  afterDraw?: () => void;
  /** What you sent that the conversation doesn't show yet. */
  sending: Array<{ text: string; at: number }>;
  /** Put files in its message (a drop from outside the app lands here). */
  addFiles?: (paths: string[]) => void;
  /** Its folder's files for @, asked now and then. */
  files?: { at: number; all: MentionHit[] };
}

const views = new Map<string, View>();

/** The folder this agent's CLI was started in; pane.ts writes it at boot. */
function dirOf(pane: Pane): string | null {
  return pane.spec.ranIn ?? null;
}

const TASK_WORD: Record<BgTask["state"], string> = { running: "Running", done: "Done", failed: "Failed", stopped: "Stopped" };
/** Most diff lines a file shows in the side panel; the Changes view has the rest. */
const MAX_FILE_DIFF = 1500;

/** A file's changes in this conversation, from the steps that made them. */
function fileDiff(f: FileChange, byId: Map<string, ChatItem>): string {
  const lines: string[] = [];
  f.steps.forEach((sid, k) => {
    const st = byId.get(sid);
    if (!st || st.kind !== "step" || !st.diff?.length) return;
    if (k && lines.length) lines.push(`<span class="gap">⋯</span>`);
    for (const l of st.diff) lines.push(`<span class="${l.sign === "+" ? "a" : l.sign === "-" ? "d" : ""}">${esc(l.sign)} ${esc(l.text)}</span>`);
  });
  if (!lines.length) return `<p class="cs-none cs-diffnone">No diff for this one here; Review all changes shows it.</p>`;
  const more = lines.length - MAX_FILE_DIFF;
  return `<pre class="cv-diff cs-diff">${lines.slice(0, MAX_FILE_DIFF).join("")}</pre>${more > 0 ? `<p class="cs-none">${more} more lines in Review all changes</p>` : ""}`;
}

/** A background command's output, as the panel shows it: the last lines, no colour codes. */
const OUT_LINES = 400;
function outputTail(text: string): string {
  return text.split(/\r?\n/).slice(-OUT_LINES).join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

type PanelTab = "changes" | "background" | "session";

/** The tab to show: the one you picked, else where the work is. */
function panelTab(v: View): PanelTab {
  const m = v.chat.meta;
  return v.panelTab ?? (m.files.length ? "changes" : m.tasks.length ? "background" : "session");
}

/** A stopped agent's background commands stopped with it. */
function taskStateOf(v: View, t: BgTask): BgTask["state"] {
  return t.state === "running" && !v.pane.running ? "stopped" : t.state;
}

/** The work panel beside the conversation: what it changed (a file's diff
 *  large), what it left running (with its output), and the session. */
function panelHtml(v: View): string {
  const m = v.chat.meta;
  const tab = panelTab(v);
  const running = m.tasks.filter((t) => taskStateOf(v, t) === "running").length;
  const tabBtn = (id: PanelTab, label: string, count: string) =>
    `<button type="button" role="tab" id="cp-t-${id}-${v.pane.id}" aria-controls="cp-b-${v.pane.id}" aria-selected="${tab === id}" tabindex="${tab === id ? 0 : -1}" data-tab="${id}">${label}${count ? `<span>${count}</span>` : ""}</button>`;
  const body = tab === "changes" ? changesHtml(v) : tab === "background" ? backgroundHtml(v) : sessionHtml(v);
  return `<div class="cp-tabs" role="tablist" aria-label="About this conversation">
      ${tabBtn("changes", "Changes", m.files.length ? String(m.files.length) : "")}
      ${tabBtn("background", "Background", running ? `${running} running` : m.tasks.length ? String(m.tasks.length) : "")}
      ${tabBtn("session", "Session", "")}
      <button type="button" class="cp-x" data-panel-toggle aria-label="Hide this panel" title="Hide the panel">${ICON_CLOSE}</button>
    </div>
    <div class="cp-body cp-${tab}" id="cp-b-${v.pane.id}" role="tabpanel" aria-labelledby="cp-t-${tab}-${v.pane.id}">${body}</div>`;
}

function changesHtml(v: View): string {
  const m = v.chat.meta;
  if (!m.files.length) return `<p class="cp-empty">Nothing changed yet in this conversation. Files it writes or edits show up here, newest first.</p>`;
  const add = m.files.reduce((n, f) => n + f.added, 0);
  const del = m.files.reduce((n, f) => n + f.removed, 0);
  const sel = m.files.find((f) => f.path === v.selFile) ?? m.files[0];
  const fresh = m.files.filter((f) => f.isNew && !f.deleted);
  const edited = m.files.filter((f) => !f.isNew || f.deleted);
  const row = (f: FileChange) => {
    const now = f.turn === m.turn && m.turn > 0;
    return `<li class="${now ? "now" : ""}${f.deleted ? " gone" : ""}"><button type="button" data-file="${esc(f.path)}" aria-current="${f === sel}" title="${esc(f.path)}${now ? " · changed in the latest reply" : ""}"><span class="cs-fn">${now ? `<i class="cs-now" aria-label="Changed in the latest reply"></i>` : ""}${esc(f.name)}</span><span class="cs-fd">${f.deleted ? "deleted · " : ""}${esc(whereIn(f.path, v.pane.spec.ranIn))}</span><span class="cv-n"><b class="a">+${f.added}</b>${f.removed ? ` <b class="d">−${f.removed}</b>` : ""}</span></button></li>`;
  };
  const group = (title: string, list: FileChange[]) => (list.length ? `<h4 class="cs-sub">${title} <span>${list.length}</span></h4><ul class="cs-files">${list.map(row).join("")}</ul>` : "");
  const byId = new Map(v.chat.items.map((i) => [i.id, i]));
  return `<div class="cp-list">
      <div class="cp-sum"><span>${m.files.length} file${m.files.length === 1 ? "" : "s"}</span><span class="cv-n"><b class="a">+${add}</b> <b class="d">−${del}</b></span></div>
      ${group("New", fresh)}${group("Edited", edited)}
      ${v.state.onReview ? `<button type="button" class="cs-review" data-review>Review all changes</button>` : ""}
    </div>
    <div class="cp-view">
      <div class="cp-vh"><b title="${esc(sel.path)}">${esc(sel.name)}</b><span>${sel.deleted ? "deleted · " : sel.isNew ? "new · " : ""}${esc(whereIn(sel.path, v.pane.spec.ranIn))}</span></div>
      ${fileDiff(sel, byId)}
    </div>`;
}

function backgroundHtml(v: View): string {
  const m = v.chat.meta;
  if (!m.tasks.length) return `<p class="cp-empty">Nothing running in the background. A dev server, a build or a watch the agent leaves running shows up here, with its output.</p>`;
  const sel = m.tasks.find((t) => t.id === v.selTask) ?? m.tasks[0];
  const out = v.taskOut.get(sel.id);
  return `<div class="cp-list">
      <ul class="cs-tasks">${m.tasks.map((t) => {
        const st = taskStateOf(v, t);
        return `<li class="${st}"><button type="button" data-task="${esc(t.id)}" aria-current="${t === sel}" title="${esc(t.command ?? t.label)}"><i aria-hidden="true"></i><span class="cs-tl">${esc(t.label)}</span><span class="cs-ts">${TASK_WORD[st]}</span></button></li>`;
      }).join("")}</ul>
    </div>
    <div class="cp-view">
      <div class="cp-vh"><b>${esc(sel.label)}</b>${sel.output ? `<button type="button" class="cs-to" data-task-refresh title="Read its output again">Refresh</button>` : ""}</div>
      ${sel.command ? `<code class="cv-full">${esc(sel.command)}</code>` : ""}
      ${!sel.output ? `<p class="cs-none">The CLI didn't say where its output goes.</p>`
        : out === undefined ? `<p class="cs-none">Reading its output…</p>`
        : `<pre class="cv-out cp-out">${esc(out) || "No output yet."}</pre>`}
    </div>`;
}

function sessionHtml(v: View): string {
  const m = v.chat.meta;
  const s = v.state;
  let html = "";
  if (m.todos?.length) {
    const done = m.todos.filter((t) => t.state === "completed").length;
    html += `<section class="cs-sec" aria-label="Plan"><h3>Plan <span>${done} of ${m.todos.length}</span></h3>
      <div class="cs-bar" aria-hidden="true"><i style="width:${Math.round((done / m.todos.length) * 100)}%"></i></div>
      <ul class="cv-todos cs-todos">${m.todos.map((t) => `<li class="${t.state}"><i aria-hidden="true"></i>${esc(t.text)}</li>`).join("")}</ul></section>`;
  }
  const rows: Array<[string, string, string?]> = [
    ["Model", modelName(m.model)],
    ["Branch", s.branch ?? ""],
    ["Folder", v.pane.spec.ranIn ? tail(v.pane.spec.ranIn, 1) : "", v.pane.spec.ranIn],
    ["Started", m.started ? when(m.started) : ""],
    ["Context", m.context ? `${tokens(m.context)} tokens` : ""],
    ["Written", m.output ? `${tokens(m.output)} tokens` : ""],
  ].filter((r): r is [string, string, string?] => !!r[1]);
  html += `<section class="cs-sec" aria-label="Session"><h3>Session</h3>${rows.length
    ? `<dl class="cs-dl">${rows.map(([k, val, full]) => `<div><dt>${k}</dt><dd title="${esc(full ?? val)}">${esc(val)}</dd></div>`).join("")}</dl>`
    : `<p class="cs-none">Details show up once it starts talking.</p>`}</section>`;
  const earlier = (v.sessions ?? []).filter((x) => x.id !== v.pane.spec.sessionId);
  const others = earlier.slice(0, 8);
  if (others.length) {
    html += `<section class="cs-sec" aria-label="Earlier conversations"><h3>Earlier conversations <span>${earlier.length}</span></h3>
      <ul class="cs-convos">${others.map((x) => `<li><button type="button" data-resume="${esc(x.id)}" title="Carry on with this conversation here"><span class="cs-ct">${esc(x.title || "Untitled")}</span><span class="cs-cm">${x.messages} message${x.messages === 1 ? "" : "s"} · ${ago(x.modified_ms)}</span></button></li>`).join("")}</ul>
      ${earlier.length > others.length ? `<button type="button" class="cs-review" data-resume-pick>All ${earlier.length} conversations</button>` : ""}</section>`;
  }
  return `<div class="cp-scroll">${html}</div>`;
}

/** Read the selected background command's output into the panel. */
async function readTaskOutput(v: View, t: BgTask): Promise<void> {
  if (!t.output) return;
  const cut = Math.max(t.output.lastIndexOf("/"), t.output.lastIndexOf("\\"));
  let text: string;
  try {
    text = outputTail((await fsReadFile(t.output.slice(0, cut), t.output.slice(cut + 1))).content);
  } catch {
    text = "Its output file is gone (background output is kept only while the session lasts).";
  }
  v.taskOut.set(t.id, text);
  v.sideSig = "";
  draw(v);
}

/** What a conversation with nothing in it says, by what the agent is doing. */
function emptyHtml(v: View): string {
  const name = esc(v.state.name);
  const st = v.state.state;
  const box = (title: string, line: string, starters = false) => `<div class="cv-empty">${title ? `<b>${title}</b>` : ""}<span>${line}</span>${starters
    ? `<div class="cv-starters">${STARTERS.map((s) => `<button type="button" data-starter="${esc(s.job)}">${esc(s.label)}</button>`).join("")}</div>` : ""}</div>`;
  if (!v.loaded) return box("", `Loading the conversation…`);
  if (v.state.problem) return box(`${name} couldn't start`, esc(v.state.problem));
  if (st === "stopped") return box(name, "Resume it to carry on, or start a new conversation.");
  if (st === "needs") return box(`${name} is waiting on you`, "Answer below to let it carry on.");
  if (st === "working") return box(`${name} is starting…`, "Its first steps show up here as it takes them.");
  return box(`What should ${name} do?`, "Say it in your own words below, or start from one of these.", true);
}

/** The element to hand focus back to after a redraw: which item, which control. */
function focusKey(root: HTMLElement): string | null {
  const a = document.activeElement as HTMLElement | null;
  if (!a || !root.contains(a)) return null;
  const item = a.closest<HTMLElement>("[data-id]")?.dataset.id;
  if (a.matches("[data-shot]")) return `[data-shot="${a.dataset.shot}"][data-k="${a.dataset.k}"]`;
  for (const sel of [".cv-sh", "[data-copy]", "[data-expand]", "[data-fold]", "[data-earlier]", "[data-starter]"]) {
    if (!a.matches(sel)) continue;
    if (sel === "[data-copy]") return `[data-copy="${a.dataset.copy}"]`;
    if (sel === "[data-expand]" || sel === "[data-fold]") return `[data-expand="${a.dataset.expand ?? a.dataset.fold}"], [data-fold="${a.dataset.fold ?? a.dataset.expand}"]`;
    if (sel === "[data-starter]") return `[data-starter="${CSS.escape(a.dataset.starter ?? "")}"]`;
    return item ? `[data-id="${item}"] > ${sel}` : sel;
  }
  return null;
}

/** What you sent stops showing as sending once the conversation has it (or after a while). */
const SENDING_MS = 90_000;
function settleSending(v: View): void {
  if (!v.sending.length) return;
  const said = new Set(v.chat.items.filter((i) => i.kind === "user").slice(-30).map((i) => ("text" in i ? i.text.trim() : "")));
  v.sending = v.sending.filter((s) => !said.has(s.text.trim()) && Date.now() - s.at < SENDING_MS);
}

function draw(v: View, force = false): void {
  const items = v.chat.items;
  settleSending(v);
  const set = (s: Set<string>) => [...s].sort().join(",");
  const sig = `${items.length}|${items.filter((i) => i.kind === "step" && i.done).length}|${v.window}|${set(v.open)}|${set(v.expanded)}|${v.path ? 1 : 0}|${v.loaded}|${v.state.state}|${v.state.problem ?? ""}|${v.state.name}|${v.sending.length}`;
  const scroller = v.el.querySelector<HTMLElement>(".cv-scroll")!;
  const thread = v.el.querySelector<HTMLElement>(".cv-thread")!;
  if (sig !== v.sig || force) {
    // Text being selected in the conversation stays put: the redraw waits until it is let go.
    const sel = document.getSelection();
    if (!force && sel && !sel.isCollapsed && sel.anchorNode && thread.contains(sel.anchorNode)) { v.held = true; }
    else {
      v.held = false;
      v.sig = sig;
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      const back = focusKey(thread);
      const start = Math.max(0, items.length - v.window);
      // Nothing of a conversation still loading: half of it would jump as the rest comes in.
      thread.innerHTML = !v.loaded ? emptyHtml(v) : (start > 0 ? `<button type="button" class="cv-earlier" data-earlier>Show ${Math.min(start, WINDOW)} earlier messages</button>` : "") +
        (items.length || v.sending.length ? threadHtml(items.slice(start), v.open, v.expanded, v.state.state === "working") : emptyHtml(v)) +
        v.sending.map((s) => `<div class="cv-u sending"><div class="cv-bubble">${esc(s.text)}</div><span class="cv-sending">Sending…</span></div>`).join("");
      if (nearBottom || force) scroller.scrollTop = scroller.scrollHeight;
      // Reading further up: new messages don't pull you down, they say they came.
      else if (v.loaded && items.length > v.seenItems) v.unseen = true;
      v.seenItems = items.length;
      v.afterDraw?.();
      if (back) thread.querySelector<HTMLElement>(back)?.focus({ preventScroll: true });
      announce(v);
    }
  }
  const working = v.state.state === "working";
  v.el.classList.toggle("working", working);
  v.el.classList.toggle("asking", !!v.state.asking);
  v.el.classList.toggle("stopped", v.state.state === "stopped");
  const wl = v.el.querySelector<HTMLElement>(".cv-working");
  if (wl) wl.hidden = !working;
  const why = v.el.querySelector<HTMLElement>(".cv-why");
  if (why) { why.textContent = v.state.problem ?? ""; why.hidden = !v.state.problem; }
  const again = v.el.querySelector<HTMLElement>("[data-restart-agent]");
  if (again) again.textContent = v.state.problem ? "Try again" : "Resume";
  // the composer's model and context, the side panel
  const m = v.chat.meta;
  const model = v.el.querySelector<HTMLElement>(".cv-model");
  if (model) {
    const name = modelName(m.model ?? v.facts?.model ?? null);
    const label = model.querySelector<HTMLElement>(".cv-chip-t");
    if (label) label.textContent = name || "Model";
    model.title = name ? `${name} · change the model` : "Change the model";
    model.hidden = !profileOf(v.pane.spec.badge).modelCommand;
  }
  for (const key of SETTINGS) {
    const btn = v.el.querySelector<HTMLElement>(`[data-setting="${key}"]`);
    const set = profileOf(v.pane.spec.badge)[key];
    if (!btn) continue;
    btn.hidden = !set;
    if (!set) continue;
    const now = settingNow(v, key);
    const label = btn.querySelector<HTMLElement>(".cv-chip-t");
    const text = key === "effort" ? (now ? `${set.name}: ${now.label}` : set.name) : (now?.label ?? set.name);
    if (label && label.textContent !== text) label.textContent = text;
    btn.title = `${set.name}${now ? `: ${now.label}` : ""} · change it`;
    btn.classList.toggle("warn", key === "permission" && /bypass|never|yolo|full/i.test(now?.id ?? ""));
  }
  const ctx = v.el.querySelector<HTMLElement>(".cv-ctx");
  if (ctx) { ctx.textContent = m.context ? `${tokens(m.context)} in context` : ""; ctx.hidden = !m.context; }
  const sideSig = JSON.stringify([m.todos, m.files, m.tasks, m.turn, v.panelTab, v.selFile, v.selTask, v.pane.running, m.model, m.context, m.output, m.started, v.state.branch, !!v.state.onReview, v.pane.spec.ranIn, v.sessions?.map((x) => x.id + x.modified_ms), v.pane.spec.sessionId]);
  applyPanel(v);
  if (sideSig !== v.sideSig) {
    v.sideSig = sideSig;
    const side = v.el.querySelector<HTMLElement>(".cv-side");
    if (side) {
      // A rebuild keeps the keyboard where it was: the same tab, file or command.
      const a = document.activeElement as HTMLElement | null;
      const back = a && side.contains(a)
        ? (["tab", "file", "task"] as const).map((k) => (a.dataset[k] ? `[data-${k}="${CSS.escape(a.dataset[k]!)}"]` : "")).find(Boolean) ?? null
        : null;
      const keep = side.querySelector<HTMLElement>(".cp-list")?.scrollTop ?? 0;
      side.innerHTML = panelHtml(v);
      const list = side.querySelector<HTMLElement>(".cp-list");
      if (list) list.scrollTop = keep;
      if (back) side.querySelector<HTMLElement>(back)?.focus({ preventScroll: true });
    }
  }
  // The background command on show needs its output read once.
  if (panelTab(v) === "background") {
    const t = m.tasks.find((x) => x.id === v.selTask) ?? m.tasks[0];
    if (t?.output && !v.taskOut.has(t.id) && !v.reading.has(t.id)) {
      v.reading.add(t.id);
      void readTaskOutput(v, t).finally(() => v.reading.delete(t.id));
    }
  }
}

const SETTINGS = ["effort", "permission"] as const;
type SettingKey = (typeof SETTINGS)[number];
/** How long a choice you just made shows before the CLI has confirmed it. */
const PENDING_MS = 6000;

/** The choice in use: what you just picked, else what the screen shows (Shift+Tab
 *  modes), else what the conversation last said. */
function settingNow(v: View, key: SettingKey): CliChoice | null {
  const set = profileOf(v.pane.spec.badge)[key];
  if (!set) return null;
  const pend = v.pending[key];
  let id: string | null = pend && Date.now() - pend.at < PENDING_MS ? pend.id : null;
  if (!id && set.cycle && v.pane.running) id = set.cycle.shown(screenOf(v.pane));
  if (!id) {
    const said = v.chat.meta[key];
    id = said ? (set.current ? set.current(said) : said) : null;
  }
  if (!id) return null;
  return set.choices.find((c) => c.id === id) ?? { id, label: id };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The bottom of the agent's terminal; "" while it has none to read. */
function screenOf(pane: Pane): string {
  try { return pane.term.snapshot(20); } catch { return ""; }
}

/** Change a CLI setting the way you would in its terminal: its command, or
 *  Shift+Tab until the footer shows the mode, or its own picker. */
async function applySetting(v: View, key: SettingKey, choice: CliChoice): Promise<void> {
  const set = profileOf(v.pane.spec.badge)[key];
  const pane = v.pane;
  if (!set) return;
  if (set.command) {
    v.pending[key] = { id: choice.id, at: Date.now() };
    draw(v, true);
    await sendMessage(pane.id, `${set.command} ${choice.id}`);
    return;
  }
  if (set.cycle) {
    v.pending[key] = { id: choice.id, at: Date.now() };
    draw(v, true);
    for (let k = 0; k < set.cycle.max; k++) {
      if (set.cycle.shown(screenOf(pane)) === choice.id) break;
      await sendInput(pane.id, set.cycle.key);
      await sleep(350);
    }
    delete v.pending[key];
    draw(v, true);
    return;
  }
  if (set.picker) {
    v.state.onTerminal?.();
    await sendMessage(pane.id, set.picker);
  }
}

/** A new answer, read out once for a screen reader (the list itself is not
 *  live: every redraw would read the whole conversation again). */
function announce(v: View): void {
  if (!v.loaded) return;
  const last = [...v.chat.items].reverse().find((i) => i.kind === "text");
  const text = last && last.kind === "text" ? last.text : "";
  if (v.said === "") { v.said = text || "\u0000"; return; } // what was already there is not news
  if (!text || text === v.said) return;
  v.said = text;
  const live = v.el.querySelector<HTMLElement>(".cv-live");
  if (live) live.textContent = `${v.state.name}: ${text.slice(0, 200)}`;
}

/** The view follows the agent's session: a new conversation (/clear, New
 *  conversation) or another one (/resume) starts the view over at once, even
 *  before the new session has written anything. */
function follow(pane: Pane, v: View): boolean {
  const id = pane.spec.sessionId;
  if (id === v.session) return false;
  v.session = id;
  forgetImages(v.chat.items);
  v.chat = newChat(pane);
  v.offset = 0;
  v.path = "";
  v.sig = "";
  v.sideSig = "";
  v.open.clear();
  v.expanded.clear();
  v.window = WINDOW;
  v.loaded = false;
  v.said = "";
  return true;
}

async function poll(pane: Pane, v: View): Promise<void> {
  if (!pane.el.isConnected) { dropChat(pane.id); return; }
  follow(pane, v);
  const dir0 = dirOf(pane);
  if (dir0 && (!v.sessionsAt || Date.now() - v.sessionsAt > 30_000)) {
    v.sessionsAt = Date.now();
    if (pane.spec.badge === "claude") void claudeSessions(dir0).then((s) => { v.sessions = s; draw(v); }).catch(() => {});
  }
  if (v.busy) return;
  v.busy = true;
  try {
    const dir = dirOf(pane);
    if (!dir) { v.loaded = true; return; }
    const since = pane.spawnedAt ? pane.spawnedAt - 5000 : null;
    // Without its own session id, only a transcript begun after this run started
    // can be its own; a stopped agent from an old session shows nothing.
    if (!pane.spec.sessionId && since === null) { v.loaded = true; return; }
    const session = pane.spec.sessionId;
    const src = sourceOf(pane);
    if (!src) { v.loaded = true; return; }
    // The first read goes to the end in one go and draws once, at the bottom: a
    // long conversation drawn slice by slice jumps and scrolls on every tick.
    const first = !v.loaded;
    let caughtUp = false;
    for (let k = 0; first || k < SLICES_PER_TICK; k++) {
      const r = await src.read(pane, dir, v.offset);
      // Without a session id of its own (a preset that picks one), a new file
      // is the only sign of a new conversation.
      if (r.path && r.path !== v.path) {
        if (v.path) { v.chat = newChat(pane); v.offset = 0; v.path = r.path; v.sig = ""; continue; }
        v.path = r.path;
      }
      if (session !== pane.spec.sessionId) return; // switched while reading: next tick
      if (!r.text) { caughtUp = true; break; }
      v.chat.feed(r.text);
      v.offset = r.next;
      if (first) await new Promise((res) => setTimeout(res, 0)); // let the window breathe between slices
    }
    if (caughtUp || !first) v.loaded = true;
    if (first && v.loaded && views.get(pane.id) === v) { draw(v, true); return; }
  } catch { /* the next tick tries again */ } finally {
    v.busy = false;
  }
  if (views.get(pane.id) === v) draw(v);
}

/** The work panel's width and whether it shows: one choice for every agent, remembered. */
const PANEL_KEY = "maestro.chat.panel";
const panelPrefs: { w?: number; hidden?: boolean } = (() => {
  try { return JSON.parse(localStorage.getItem(PANEL_KEY) || "{}") as { w?: number; hidden?: boolean }; } catch { return {}; }
})();
function savePanel(): void {
  try { localStorage.setItem(PANEL_KEY, JSON.stringify(panelPrefs)); } catch { /* storage blocked */ }
}
/** Below this width the panel slides over the conversation instead of sharing the row. */
const PANEL_NARROW = 900;
const PANEL_MIN = 320;
const CHAT_MIN = 400;
function setPanelWidth(el: HTMLElement, w: number): void {
  const total = el.clientWidth;
  const clamped = Math.round(total ? Math.max(PANEL_MIN, Math.min(w, total - CHAT_MIN)) : Math.max(PANEL_MIN, w));
  panelPrefs.w = clamped;
  el.style.setProperty("--cv-side-w", `${clamped}px`);
}
function applyPanel(v: View): void {
  if (panelPrefs.w) v.el.style.setProperty("--cv-side-w", `${panelPrefs.w}px`);
  v.el.classList.toggle("panel-off", !!panelPrefs.hidden);
  const shown = v.el.clientWidth && v.el.clientWidth < PANEL_NARROW ? v.el.classList.contains("peek") : !panelPrefs.hidden;
  const btn = v.el.querySelector<HTMLElement>(".cv-ptoggle");
  if (btn) {
    btn.setAttribute("aria-pressed", String(shown));
    btn.setAttribute("aria-label", shown ? "Hide the work panel" : "Show the work panel");
  }
}

function mount(pane: Pane): View {
  const host = pane.el.querySelector<HTMLElement>(".term-host") ?? pane.el;
  const el = document.createElement("section");
  el.className = "cv";
  el.setAttribute("aria-label", `Conversation with ${pane.spec.name}`);
  // The pane's own tooltip (the terminal's title) is not about the chat.
  el.title = "";
  el.innerHTML = `
    <div class="cv-main">
    <button type="button" class="cv-ptoggle" data-panel-toggle aria-label="Show the work panel" title="Changes, background and session"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M9.5 3v10" /></svg></button>
    <div class="cv-find" role="search" hidden>
      <svg class="cv-find-i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2 13.5 13.5" /></svg>
      <input type="text" class="cv-find-in" aria-label="Find in the conversation" placeholder="Find in the conversation" spellcheck="false">
      <span class="cv-find-n" aria-live="polite"></span>
      <button type="button" data-find="-1" aria-label="Previous match" title="Previous (Shift+Enter)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4" /></svg></button>
      <button type="button" data-find="1" aria-label="Next match" title="Next (Enter)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg></button>
      <button type="button" data-find-close aria-label="Close find" title="Close (Esc)">${ICON_CLOSE}</button>
    </div>
    <div class="cv-scroll"><div class="cv-thread" role="log" aria-live="off"></div></div>
    <p class="ia-sr cv-live" aria-live="polite"></p>
    <div class="cv-foot" role="status">
      <button type="button" class="cv-jump" data-jump hidden><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M4 9l4 4 4-4" /></svg><span>Latest</span></button>
      <p class="cv-working" hidden><span class="cv-dots" aria-hidden="true"><i></i><i></i><i></i></span>Working</p>
      <div class="cv-stopped"><span class="cv-sl">Stopped</span><span class="cv-why" hidden></span><button type="button" class="cv-restart" data-restart-agent>Resume</button><button type="button" class="cv-new" data-new-convo>New conversation</button></div>
      <form class="cv-compose">
        <label class="ia-sr" for="cv-in-${pane.id}">Message ${esc(pane.spec.name)}</label>
        <div class="cv-mention" id="cv-men-${pane.id}" role="listbox" aria-label="Files in its folder" hidden></div>
        <div class="cv-atts" hidden></div>
        <textarea id="cv-in-${pane.id}" rows="1" placeholder="Message ${esc(pane.spec.name)}… (@ for a file)" title="Enter sends · Shift+Enter starts a new line · @ picks a file" role="combobox" aria-autocomplete="list" aria-controls="cv-men-${pane.id}" aria-expanded="false"></textarea>
        <div class="cv-bar">
          <button type="button" class="cv-chip cv-attach" data-attach aria-label="Attach files" title="Attach files (or drop them here, or type @)"><svg class="cv-chip-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg></button>
          <button type="button" class="cv-chip cv-model" data-model aria-haspopup="menu" title="Change the model" hidden><span class="cv-chip-t">Model</span><svg class="cv-chip-c" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" /></svg></button>
          <button type="button" class="cv-chip cv-set" data-setting="effort" aria-haspopup="menu" hidden><svg class="cv-chip-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.5a5.5 5.5 0 1 1 10 0" /><path d="M8 11.5 10.5 7" /></svg><span class="cv-chip-t">Effort</span><svg class="cv-chip-c" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" /></svg></button>
          <button type="button" class="cv-chip cv-set" data-setting="permission" aria-haspopup="menu" hidden><svg class="cv-chip-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 3 4v4c0 3 2.2 5 5 6 2.8-1 5-3 5-6V4z" /></svg><span class="cv-chip-t">Permissions</span><svg class="cv-chip-c" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" /></svg></button>
          <button type="button" class="cv-chip cv-cmds" data-cmds aria-haspopup="dialog" title="The CLI's own commands (type / to open)"><span class="cv-chip-t">/ Commands</span></button>
          <span class="cv-ctx" title="How much the agent is holding in mind right now" hidden></span>
          <span class="cv-sp"></span>
          <button type="button" class="cv-stop" data-stop title="Stop what it is doing (Esc)">Stop</button>
          <button type="submit" class="cv-send" aria-label="Send" title="Send (Enter)">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
          </button>
        </div>
      </form>
    </div>
    </div>
    <div class="cv-grip" role="separator" aria-orientation="vertical" aria-label="Resize the work panel" tabindex="0"></div>
    <aside class="cv-side" aria-label="About this conversation"></aside>`;
  host.appendChild(el);
  // A small picture (a cropped thumbnail) grows to a readable size once its size is known.
  el.addEventListener("load", (e) => {
    const t = e.target;
    if (t instanceof HTMLImageElement && t.parentElement?.classList.contains("cv-shot")) fitShot(t);
  }, true);
  const v: View = { el, chat: newChat(pane), offset: 0, path: "", sig: "", window: WINDOW, open: new Set(), expanded: new Set(), timer: null, busy: false, state: { name: pane.spec.name, state: "idle" }, pane, sideSig: "", loaded: false, held: false, said: "", pending: {}, taskOut: new Map(), reading: new Set(), sending: [], unseen: false, seenItems: 0 };
  applyPanel(v);
  // Drag the grip (or use the arrow keys on it) to share the row between the conversation and the panel.
  const grip = el.querySelector<HTMLElement>(".cv-grip")!;
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    el.classList.add("resizing");
    const move = (ev: PointerEvent) => setPanelWidth(el, el.getBoundingClientRect().right - ev.clientX);
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      el.classList.remove("resizing");
      savePanel();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  /** A file named in an answer, in the code panel: as written when it is a full
   *  path, else in the agent's folder, else the one file of that name there. */
  const openRef = async (ref: string) => {
    const dir = (pane.spec.ranIn ?? pane.spec.cwd ?? "").replace(/[\\/]+$/, "");
    const clean = ref.replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(clean) || clean.startsWith("/")) { openFileInPanel(clean); return; }
    if (clean.includes("/") || !dir) { openFileInPanel(dir ? `${dir}/${clean.replace(/^\.\//, "")}` : clean); return; }
    const dirFiles = v.files?.all ?? withFolders(await workspaceFiles(dir).catch(() => [] as string[]));
    const hit = dirFiles.find((h) => !h.folder && (h.path === clean || h.path.endsWith(`/${clean}`)));
    openFileInPanel(`${dir}/${hit ? hit.path : clean}`);
  };
  // Enter on a file name opens it too.
  el.addEventListener("keydown", (e) => {
    const ref = (e.target as HTMLElement).closest<HTMLElement>("[data-file-ref]");
    if (ref && e.key === "Enter") { e.preventDefault(); void openRef(ref.dataset.fileRef ?? ""); }
  });

  // Latest: shown while you read further up, saying when new messages came.
  const scroller = el.querySelector<HTMLElement>(".cv-scroll")!;
  const jump = el.querySelector<HTMLElement>(".cv-jump")!;
  const showJump = () => {
    const far = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 240;
    if (!far && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80) v.unseen = false;
    jump.hidden = !far && !v.unseen;
    jump.classList.toggle("new", v.unseen);
    jump.querySelector("span")!.textContent = v.unseen ? "New messages" : "Latest";
  };
  scroller.addEventListener("scroll", showJump, { passive: true });

  // Ctrl+F: find in the conversation, every match marked, the current one brighter.
  const findBar = el.querySelector<HTMLElement>(".cv-find")!;
  const findIn = el.querySelector<HTMLInputElement>(".cv-find-in")!;
  const findN = el.querySelector<HTMLElement>(".cv-find-n")!;
  const marks = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const Mark = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  let found: Range[] = [];
  let at = 0;
  const paint = () => {
    if (!marks || !Mark) return;
    if (!found.length) { marks.delete(`cv-find`); marks.delete(`cv-find-now`); return; }
    marks.set("cv-find", new Mark(...found));
    marks.set("cv-find-now", new Mark(found[at]));
  };
  const showMatch = () => {
    findN.textContent = findIn.value.trim() ? (found.length ? `${at + 1} of ${found.length}` : "No match") : "";
    paint();
    const r = found[at];
    if (!r) return;
    const box = r.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (box.top < view.top + 40 || box.bottom > view.bottom - 40) scroller.scrollTop += box.top - view.top - view.height / 3;
  };
  const runFind = (keep = false) => {
    const q = findIn.value.trim().toLowerCase();
    found = [];
    if (q) {
      const thread = el.querySelector<HTMLElement>(".cv-thread")!;
      const walk = document.createTreeWalker(thread, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const text = (n.textContent ?? "").toLowerCase();
        for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + q.length);
          found.push(r);
        }
      }
    }
    at = keep ? Math.min(at, Math.max(0, found.length - 1)) : Math.max(0, found.length - 1); // start from the newest
    showMatch();
  };
  const openFind = () => {
    findBar.hidden = false;
    const sel = document.getSelection()?.toString().trim();
    if (sel && sel.length < 80 && !sel.includes("\n")) findIn.value = sel;
    findIn.focus();
    findIn.select();
    runFind();
  };
  const closeFind = () => {
    findBar.hidden = true;
    found = [];
    paint();
    findN.textContent = "";
    input.focus();
  };
  v.afterDraw = () => { showJump(); if (!findBar.hidden) runFind(true); };
  findIn.addEventListener("input", () => runFind());
  findIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (found.length) { at = (at + (e.shiftKey ? -1 : 1) + found.length) % found.length; showMatch(); } }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
  });
  el.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); e.stopPropagation(); openFind(); }
  });

  // Left and right move between the panel's tabs, the way a tab list does.
  el.addEventListener("keydown", (e) => {
    const tabEl = (e.target as HTMLElement).closest<HTMLElement>("[role=tab]");
    if (!tabEl || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const tabs = [...el.querySelectorAll<HTMLElement>("[role=tab]")];
    const next = tabs[(tabs.indexOf(tabEl) + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    v.panelTab = next.dataset.tab as PanelTab;
    draw(v);
    el.querySelector<HTMLElement>(`[data-tab="${next.dataset.tab}"]`)?.focus();
  });
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const side = el.querySelector<HTMLElement>(".cv-side");
    setPanelWidth(el, (side?.getBoundingClientRect().width ?? PANEL_MIN) + (e.key === "ArrowLeft" ? 32 : -32));
    savePanel();
  });
  const input = el.querySelector<HTMLTextAreaElement>("textarea")!;
  const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; };
  /** Switching conversations stops what it is doing: ask first while it works. */
  const okToSwitch = async (what: string): Promise<boolean> => {
    if (v.state.state !== "working") return true;
    const r = await confirmModal({ title: `Stop ${pane.spec.name} and ${what}?`, message: `${pane.spec.name} is working. It stops now, and the conversation it is in stays in its list of earlier ones.`, okLabel: "Stop and switch", danger: true });
    return r.ok;
  };
  const restartWith = async (opts: { fresh?: boolean; session?: string; dir?: string }, what: string) => {
    if (await okToSwitch(what)) void pane.restart?.(opts);
  };
  /** Carry on an earlier conversation. Claude resumes one only in the folder
   *  it ran in, so for one from elsewhere the agent starts again there. */
  const resumeTo = (x: ClaudeSession) => {
    if (x.id === pane.spec.sessionId && pane.running) return;
    // Where it runs when it isn't carrying on a conversation from elsewhere.
    const home = pane.spec.worktree ?? pane.spec.cwd ?? pane.spec.ranIn ?? "";
    const there = x.cwd && home && !samePath(x.cwd, home) ? x.cwd : undefined;
    void restartWith(there ? { session: x.id, dir: there } : { session: x.id }, "switch conversations");
  };
  /** Pictures pasted into the composer, waiting to go with the next message. */
  const atts: Attachment[] = [];
  const attsEl = el.querySelector<HTMLElement>(".cv-atts")!;
  const drawAtts = () => {
    attsEl.hidden = !atts.length;
    attsEl.innerHTML = atts.map((a, k) => `<span class="cv-att${a.failed ? " failed" : ""}"><button type="button" class="cv-att-open" data-att-open="${k}" aria-label="Pasted picture ${k + 1}, open full size" title="${a.failed ? "Couldn't save this picture" : "Open full size"}"><img src="${a.url}" alt=""></button><button type="button" class="cv-att-x" data-att-x="${k}" aria-label="Remove pasted picture ${k + 1}" title="Remove">${ICON_CLOSE}</button></span>`).join("");
  };
  const dropAtt = (k: number) => {
    const [a] = atts.splice(k, 1);
    if (a) URL.revokeObjectURL(a.url);
    drawAtts();
  };
  /** Text where you are typing, a space before it when it would run into a word. */
  const insertText = (t: string) => {
    const s = input.selectionStart ?? input.value.length;
    const pad = s > 0 && !/\s$/.test(input.value.slice(0, s)) ? " " : "";
    input.setRangeText(pad + t, s, input.selectionEnd ?? s, "end");
    grow();
  };
  /** Files into the message: pictures as attachments, the rest as @path where you are typing. */
  const addFiles = (paths: string[]) => {
    const dir = pane.spec.ranIn ?? pane.spec.cwd;
    const words: string[] = [];
    for (const p of paths) {
      if (PICTURE_PATH.test(p) && atts.length < MAX_ATTACHMENTS) {
        const a: Attachment = { url: "", pic: pictureAt("", mediaOf(p)), path: Promise.resolve(p) };
        atts.push(a);
        const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
        void fsReadDataUrl(p.slice(0, cut), p.slice(cut + 1))
          .then((u) => { a.url = u; a.pic = pictureAt(u, mediaOf(p)); drawAtts(); })
          .catch(() => { a.failed = true; drawAtts(); });
      } else words.push(fileMention(p, dir));
    }
    if (words.length) insertText(words.join(" ") + " ");
    drawAtts();
    input.focus();
  };
  v.addFiles = addFiles;
  input.addEventListener("paste", (e) => {
    const files = pastedFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) { input.setRangeText(text, input.selectionStart, input.selectionEnd, "end"); grow(); }
    for (const f of files) {
      if (PASTE_TYPES[f.type]) {
        if (atts.length >= MAX_ATTACHMENTS) continue;
        const url = URL.createObjectURL(f);
        const a: Attachment = { url, pic: pictureAt(url, f.type), path: Promise.resolve(null) };
        a.path = savePasted(f).catch(() => { a.failed = true; drawAtts(); return null; });
        atts.push(a);
      } else {
        // A file copied in Explorer: the page gets its content, not its path; saved, it goes in as @path.
        void base64Of(f).then((data) => savePastedFile(data, f.name)).then((p) => insertText(fileMention(p) + " ")).catch(() => {});
      }
    }
    drawAtts();
  });
  const send = () => {
    const text = input.value.trim();
    if (!text && !atts.length) return;
    if (atts.length) {
      const sending = atts.splice(0);
      drawAtts();
      input.value = "";
      grow();
      void (async () => {
        const paths = (await Promise.all(sending.map((a) => a.path))).filter((p): p is string => !!p);
        sending.forEach((a) => URL.revokeObjectURL(a.url));
        // Each picture goes in as its own path, the way a dropped file does, so
        // the CLI attaches it; the words follow and send it all.
        paths.forEach((p, k) => {
          const last = k === paths.length - 1 && !text;
          void sendMessage(pane.id, p, last);
          if (!last) void sendMessage(pane.id, " ", false);
        });
        if (text) void sendMessage(pane.id, text);
      })();
      noteSent(text);
      return;
    }
    // /resume and /clear are Claude Code's; other CLIs answer their own commands.
    const own = pane.spec.badge === "claude" ? chatCommand(text) : null;
    if (own) {
      input.value = "";
      grow();
      if (own.kind === "resume") void pickConversation(own.query);
      else void restartWith({ fresh: true }, "start a new conversation");
      return;
    }
    input.value = "";
    grow();
    void sendMessage(pane.id, text);
    noteSent(text);
  };
  /** What you sent shows at once, as sending, until the conversation has it. */
  const noteSent = (text: string) => {
    if (text) v.sending.push({ text, at: Date.now() });
    saveDraft("");
    hist.k = -1;
    draw(v, true);
  };
  // The draft stays with the agent: switching agents or restarting Maestro keeps it.
  const draftKey = `maestro.chat.draft.${pane.id}`;
  const saveDraft = (text: string) => {
    try { if (text) localStorage.setItem(draftKey, text); else localStorage.removeItem(draftKey); } catch { /* storage blocked */ }
  };
  try { input.value = localStorage.getItem(draftKey) ?? ""; } catch { /* storage blocked */ }
  input.addEventListener("input", () => { grow(); saveDraft(input.value); hist.k = -1; });
  // Up and Down walk back through what you sent, like a shell; Down past the newest gives the draft back.
  const hist = { k: -1, draft: "" };
  const sentBefore = () => [...v.sending.map((s) => s.text).reverse(), ...v.chat.items.filter((i) => i.kind === "user").map((i) => ("text" in i ? i.text : "")).reverse()]
    .filter((t, k, all) => t && all.indexOf(t) === k);
  const recall = (d: 1 | -1): boolean => {
    const list = sentBefore();
    const k = hist.k + d;
    if (k < -1 || k >= list.length) return false;
    if (hist.k === -1) hist.draft = input.value;
    hist.k = k;
    input.value = k === -1 ? hist.draft : list[k];
    input.setSelectionRange(input.value.length, input.value.length);
    grow();
    return true;
  };
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.shiftKey || e.altKey || e.ctrlKey || (mention && !menEl.hidden)) return;
    const caret = input.selectionStart ?? 0;
    const onFirstLine = !input.value.slice(0, caret).includes("\n") && input.selectionStart === input.selectionEnd;
    const onLastLine = !input.value.slice(caret).includes("\n") && input.selectionStart === input.selectionEnd;
    if (e.key === "ArrowUp" && onFirstLine && (hist.k >= 0 || !input.value.trim()) && recall(1)) e.preventDefault();
    else if (e.key === "ArrowDown" && onLastLine && hist.k >= 0 && recall(-1)) e.preventDefault();
  });
  /** Claude's conversations in this folder; picking one resumes it here
   *  (claude --resume <id>), so the chat knows which conversation it shows. */
  const pickConversation = async (query: string) => {
    const dir = pane.spec.ranIn ?? pane.spec.cwd;
    if (!dir) return;
    const [here, everywhere] = await Promise.all([
      claudeSessions(dir).catch(() => v.sessions ?? []),
      claudeSessionsEverywhere().catch(() => [] as ClaudeSession[]),
    ]);
    v.sessions = here;
    v.sessionsAt = Date.now();
    const seen = new Set(here.map((x) => x.id));
    const elsewhere = everywhere.filter((x) => !seen.has(x.id) && x.cwd && !samePath(x.cwd, dir));
    const pick = resumeTo;
    const words = (x: ClaudeSession) => `${x.messages} message${x.messages === 1 ? "" : "s"} · ${ago(x.modified_ms)}`;
    const items: PaletteItem[] = [
      ...here.map((x) => ({ group: x.id === pane.spec.sessionId ? "This conversation" : "In this folder", label: x.title || "Untitled", sub: words(x), run: () => pick(x) })),
      ...elsewhere.map((x) => ({ group: "In other folders", label: x.title || "Untitled", sub: `${tail(x.cwd, 2)} · ${words(x)}`, run: () => pick(x) })),
    ];
    if (!items.length) items.push({ group: "Conversations", label: "No earlier conversations", run: () => {} });
    openPalette(items, { placeholder: query ? `Resume a conversation: ${query}` : "Resume a conversation" });
    const q = document.getElementById("palQ") as HTMLInputElement | null;
    if (q && query) { q.value = query; q.dispatchEvent(new Event("input", { bubbles: true })); }
  };
  /** The CLI's own commands, searchable; the pick goes into the composer. When
   *  the CLI won't say, the two the chat answers itself are still there, and
   *  the terminal shows the CLI's own list. */
  const pickCommand = async () => {
    const btn = el.querySelector<HTMLButtonElement>("[data-cmds]");
    const asked = cliFacts(pane.spec.badge, pane.spec.program, pane.spec.ranIn ?? pane.spec.cwd);
    if (!asked) return;
    btn?.setAttribute("aria-busy", "true");
    btn?.classList.add("busy");
    let commands: CliFacts["commands"] = [];
    let failed = false;
    try {
      v.facts = await asked;
      commands = v.facts.commands;
    } catch {
      failed = true;
    } finally {
      btn?.removeAttribute("aria-busy");
      btn?.classList.remove("busy");
    }
    const group = { command: "Commands", skill: "Skills", plugin: "Plugins" } as const;
    const listed = new Set(commands.map((c) => c.name));
    const mine = (["resume", "clear"] as const).filter((n) => !listed.has(n)).map((n) => ({ name: n, kind: "command" as const }));
    const items: PaletteItem[] = [...mine, ...commands].map((c) => ({
      group: group[c.kind], label: `/${c.name}`,
      run: () => { input.value = `/${c.name} `; grow(); input.focus(); },
    }));
    if (failed) {
      items.push({
        group: "The CLI's own list", label: "Show all of its commands in the terminal",
        sub: `${pane.spec.name}'s CLI didn't answer in time`,
        run: () => { v.state.onTerminal?.(); void sendInput(pane.id, "/"); },
      });
    }
    openPalette(items, { placeholder: failed ? "Commands: type to search" : `${commands.length} commands from ${pane.spec.name}'s CLI: type to search` });
  };
  // Warm the list up, so the first / opens at once.
  void cliFacts(pane.spec.badge, pane.spec.program, pane.spec.ranIn ?? pane.spec.cwd)?.then((f) => { v.facts = f; draw(v); }).catch(() => {});
  // @: a file or folder of the agent's folder, picked from a list as you type.
  let mention: { start: number; hits: MentionHit[]; k: number } | null = null;
  const menEl = el.querySelector<HTMLElement>(".cv-mention")!;
  const filesOf = async (): Promise<MentionHit[]> => {
    const dir = pane.spec.ranIn ?? pane.spec.cwd;
    if (!dir) return [];
    if (!v.files || Date.now() - v.files.at > 60_000) {
      const list = await workspaceFiles(dir).catch(() => [] as string[]);
      v.files = { at: Date.now(), all: withFolders(list) };
    }
    return v.files.all;
  };
  const closeMention = () => {
    mention = null;
    menEl.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const drawMention = (query: string) => {
    if (!mention) return;
    menEl.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (!mention.hits.length) {
      menEl.innerHTML = `<p class="cv-mnone">No file in its folder matches “${esc(query)}”</p>`;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    menEl.innerHTML = mention.hits.map((h, k) => `<button type="button" role="option" id="cv-men-${pane.id}-${k}" aria-selected="${k === mention!.k}" data-mention="${k}" tabindex="-1">${h.folder ? MENTION_FOLDER : MENTION_FILE}<span class="cv-mn">${esc(h.name)}</span><span class="cv-md">${esc(h.dir)}</span></button>`).join("");
    input.setAttribute("aria-activedescendant", `cv-men-${pane.id}-${mention.k}`);
    menEl.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };
  const updateMention = async () => {
    if (!mentionAt(input.value, input.selectionStart ?? 0)) { closeMention(); return; }
    const all = await filesOf();
    // what you typed while the list was being read
    const at = mentionAt(input.value, input.selectionStart ?? 0);
    if (!at) { closeMention(); return; }
    mention = { start: at.start, hits: mentionMatches(all, at.query), k: 0 };
    drawMention(at.query);
  };
  const pickMention = (k: number) => {
    const h = mention?.hits[k];
    if (!mention || !h) return;
    const r = applyMention(input.value, mention.start, input.selectionStart ?? input.value.length, h.path);
    input.value = r.text;
    input.setSelectionRange(r.caret, r.caret);
    closeMention();
    grow();
    input.focus();
  };
  input.addEventListener("input", () => void updateMention());
  input.addEventListener("click", () => void updateMention());
  input.addEventListener("blur", () => closeMention());
  // A click on the list keeps the keyboard in the composer.
  menEl.addEventListener("pointerdown", (e) => e.preventDefault());
  menEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-mention]");
    if (b) pickMention(Number(b.dataset.mention));
  });
  input.addEventListener("keydown", (e) => {
    if (mention && !menEl.hidden) {
      const n = mention.hits.length;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
        e.preventDefault();
        mention.k = (mention.k + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
        drawMention("");
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && n && !e.isComposing) { e.preventDefault(); pickMention(mention.k); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMention(); return; }
    }
    if (e.key === "/" && !input.value && cliFacts(pane.spec.badge, pane.spec.program, pane.spec.ranIn ?? pane.spec.cwd)) { e.preventDefault(); void pickCommand(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  el.querySelector("form")!.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  const stop = () => { void sendInput(pane.id, "\x1b"); input.focus(); };
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    // A link in an answer opens in the browser; the app's window stays the app.
    const link = t.closest<HTMLAnchorElement>("a[href]");
    if (link) { e.preventDefault(); void openExternal(link.href); return; }
    // The pane's own restart button knows how to start this agent again.
    if (t.closest("[data-restart-agent]")) { void pane.restart?.(); return; }
    if (t.closest("[data-new-convo]")) { void restartWith({ fresh: true }, "start a new conversation"); return; }
    const resumeOne = t.closest<HTMLElement>("[data-resume]");
    if (resumeOne) {
      const x = v.sessions?.find((s) => s.id === resumeOne.dataset.resume);
      if (x) resumeTo(x);
      return;
    }
    if (t.closest("[data-resume-pick]")) { void pickConversation(""); return; }
    if (t.closest("[data-attach]")) {
      void pickFiles(pane.spec.ranIn ?? pane.spec.cwd ?? undefined).then((paths) => { if (paths.length) addFiles(paths); }).catch(() => {});
      return;
    }
    if (t.closest("[data-jump]")) { v.unseen = false; scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }); return; }
    const findBtn = t.closest<HTMLElement>("[data-find]");
    if (findBtn) { if (found.length) { at = (at + Number(findBtn.dataset.find) + found.length) % found.length; showMatch(); } findIn.focus(); return; }
    if (t.closest("[data-find-close]")) { closeFind(); return; }
    const codeCopy = t.closest<HTMLElement>("[data-copy-code]");
    if (codeCopy) {
      const code = codeCopy.closest("pre")?.querySelector("code")?.textContent ?? "";
      void navigator.clipboard?.writeText(code).then(() => { codeCopy.textContent = "Copied"; window.setTimeout(() => { codeCopy.textContent = "Copy"; }, 1400); }).catch(() => {});
      return;
    }
    const ref = t.closest<HTMLElement>("[data-file-ref]");
    if (ref) { void openRef(ref.dataset.fileRef ?? ""); return; }
    const attX = t.closest<HTMLElement>("[data-att-x]");
    if (attX) { dropAtt(Number(attX.dataset.attX)); input.focus(); return; }
    const attOpen = t.closest<HTMLElement>("[data-att-open]");
    if (attOpen) { openImage(atts.map((a) => a.pic), Number(attOpen.dataset.attOpen) || 0, "You're sending"); return; }
    const shot = t.closest<HTMLElement>("[data-shot]");
    if (shot) {
      const owner = v.chat.items.find((i) => i.id === shot.dataset.shot);
      const pics = owner?.kind === "step" ? owner.images : owner?.kind === "user" ? owner.pics : undefined;
      const what = owner?.kind === "step" ? `${owner.verb} ${owner.target}`.trim() : "You sent";
      if (pics?.length) openImage(pics, Number(shot.dataset.k) || 0, what);
      return;
    }
    const starter = t.closest<HTMLElement>("[data-starter]");
    if (starter) { input.value = starter.dataset.starter ?? ""; grow(); input.focus(); return; }
    const cmds = t.closest<HTMLButtonElement>("[data-cmds]");
    if (cmds) { void pickCommand(); return; }
    const setBtn = t.closest<HTMLElement>("[data-setting]");
    if (setBtn) {
      const key = setBtn.dataset.setting as SettingKey;
      const set = profileOf(pane.spec.badge)[key];
      if (!set) return;
      const now = settingNow(v, key);
      const r = setBtn.getBoundingClientRect();
      setBtn.setAttribute("aria-expanded", "true");
      openMenu(r.left, r.top - 8, [
        ...set.choices.map((c) => ({
          label: c.label,
          hint: c.id === now?.id ? "In use" : set.picker ? "In the terminal" : c.hint,
          run: () => { void applySetting(v, key, c); },
        })),
      ], set.name);
      const off = () => { setBtn.setAttribute("aria-expanded", "false"); window.removeEventListener("pointerdown", off, true); window.removeEventListener("keydown", off, true); };
      window.addEventListener("pointerdown", off, true);
      window.addEventListener("keydown", off, true);
      return;
    }
    // the work panel: show or hide it, its tabs, a file's diff, a command's output
    if (t.closest("[data-panel-toggle]")) {
      if (el.clientWidth < PANEL_NARROW) el.classList.toggle("peek");
      else { panelPrefs.hidden = !panelPrefs.hidden; savePanel(); el.classList.remove("peek"); }
      applyPanel(v);
      return;
    }
    const tabBtn = t.closest<HTMLElement>("[data-tab]");
    if (tabBtn) { v.panelTab = tabBtn.dataset.tab as PanelTab; draw(v); return; }
    const fileBtn = t.closest<HTMLElement>("[data-file]");
    if (fileBtn) { v.selFile = fileBtn.dataset.file; v.panelTab = "changes"; draw(v); return; }
    const taskBtn = t.closest<HTMLElement>("[data-task]");
    if (taskBtn) { v.selTask = taskBtn.dataset.task; v.panelTab = "background"; draw(v); return; }
    if (t.closest("[data-task-refresh]")) {
      const task = v.chat.meta.tasks.find((x) => x.id === v.selTask) ?? v.chat.meta.tasks[0];
      if (task) { v.taskOut.delete(task.id); draw(v); }
      return;
    }
    const modelBtn = t.closest<HTMLElement>("[data-model]");
    if (modelBtn) {
      const p = profileOf(pane.spec.badge);
      if (!p.modelCommand) return;
      const r = modelBtn.getBoundingClientRect();
      // Only what this conversation itself says is in use; every model stays
      // pickable (choosing the one in use again is harmless).
      const inUse = modelAlias(v.chat.meta.model);
      modelBtn.setAttribute("aria-expanded", "true");
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
      const off = () => { modelBtn.setAttribute("aria-expanded", "false"); window.removeEventListener("pointerdown", off, true); window.removeEventListener("keydown", off, true); };
      window.addEventListener("pointerdown", off, true);
      window.addEventListener("keydown", off, true);
      return;
    }
    const copy = t.closest<HTMLElement>("[data-copy]");
    if (copy) {
      // The footer may belong to a turn whose start is above the drawn window:
      // copy the whole turn it ends.
      const turn = turnsOf(v.chat.items).find((x) => x.items.some((i) => i.id === copy.dataset.copy));
      const text = turn?.items.filter((i) => i.kind === "text").map((i) => ("text" in i ? i.text : "")).join("\n\n") ?? "";
      if (!text) { copy.textContent = "Nothing to copy"; window.setTimeout(() => { copy.textContent = "Copy"; }, 1400); return; }
      void navigator.clipboard?.writeText(text).then(() => { copy.textContent = "Copied"; window.setTimeout(() => { copy.textContent = "Copy"; }, 1400); }).catch(() => {});
      return;
    }
    if (t.closest("[data-review]")) { v.state.onReview?.(); return; }
    if (t.closest("[data-stop]")) { stop(); return; }
    if (t.closest("[data-earlier]")) {
      // New messages go in above: keep the one you were reading where it was.
      const scroller = el.querySelector<HTMLElement>(".cv-scroll")!;
      const h = scroller.scrollHeight;
      v.window += WINDOW;
      draw(v);
      scroller.scrollTop += scroller.scrollHeight - h;
      return;
    }
    const more = t.closest<HTMLElement>("[data-expand]");
    if (more) { v.expanded.add(more.dataset.expand!); draw(v); return; }
    const fold = t.closest<HTMLElement>("[data-fold]");
    if (fold) { v.expanded.delete(fold.dataset.fold!); draw(v); return; }
    const head = t.closest<HTMLElement>("button.cv-sh");
    const step = head?.closest<HTMLElement>(".cv-step");
    if (step) {
      const id = step.dataset.id!;
      const isTodo = v.chat.items.find((i) => i.id === id && i.kind === "step" && i.tool === "TodoWrite");
      const openNow = step.classList.contains("open");
      if (isTodo) { if (openNow) v.open.delete(id), v.open.add(`!${id}`); else v.open.delete(`!${id}`), v.open.add(id); }
      else if (openNow) v.open.delete(id); else v.open.add(id);
      draw(v);
    }
  });
  el.addEventListener("keydown", (e) => {
    // Esc stops a working agent from anywhere in the conversation.
    if (e.key === "Escape" && v.state.state === "working" && !document.querySelector(".cm-menu, .inbox-modal-back")) { e.preventDefault(); stop(); }
    // Plain keys typed in the conversation stay here, away from the hidden
    // terminal; app shortcuts (Ctrl, Alt) still reach the app.
    if (!e.ctrlKey && !e.altKey && !e.metaKey) e.stopPropagation();
  });
  // A redraw held for a selection happens once the selection is let go.
  const onSelection = () => { if (v.held && document.getSelection()?.isCollapsed) draw(v); };
  document.addEventListener("selectionchange", onSelection);
  v.off = () => document.removeEventListener("selectionchange", onSelection);
  views.set(pane.id, v);
  return v;
}

/** Show the conversation over this pane's terminal and keep it current. */
export function showChat(pane: Pane, state: ChatState, focus = false): void {
  const v = views.get(pane.id) ?? mount(pane);
  const renamed = v.state.name !== state.name;
  v.state = state;
  if (renamed) {
    v.el.setAttribute("aria-label", `Conversation with ${state.name}`);
    const input = v.el.querySelector<HTMLTextAreaElement>("textarea");
    if (input) input.placeholder = `Message ${state.name}…`;
    const label = v.el.querySelector<HTMLElement>(".cv-compose label");
    if (label) label.textContent = `Message ${state.name}`;
  }
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

/** A picture full size over everything: ← → between the pictures of the same
 *  step, Esc or a click outside closes it, and the keyboard goes back. */
export function openImage(pics: ChatImage[], start: number, what: string): void {
  document.querySelector(".cv-lb")?.remove();
  const back = document.activeElement as HTMLElement | null;
  let k = Math.max(0, Math.min(pics.length - 1, start));
  const el = document.createElement("div");
  el.className = "inbox-modal-back cv-lb";
  el.innerHTML = `<div class="cv-lb-box" role="dialog" aria-modal="true" aria-label="${esc(what)}">
      <header class="cv-lb-bar"><span class="cv-lb-t">${esc(what)}</span><span class="cv-lb-n"></span>
        <button type="button" class="im-x" data-lb-close aria-label="Close" title="Close (Esc)">${ICON_CLOSE}</button></header>
      <div class="cv-lb-stage">
        <button type="button" class="cv-lb-nav prev" data-lb="-1" aria-label="Previous picture"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
        <img class="cv-lb-img" src="${urlOf(pics[k])}" alt="${esc(what)}">
        <button type="button" class="cv-lb-nav next" data-lb="1" aria-label="Next picture"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
      </div></div>`;
  document.body.appendChild(el);
  const img = el.querySelector<HTMLImageElement>(".cv-lb-img")!;
  const count = el.querySelector<HTMLElement>(".cv-lb-n")!;
  // Full size means at least filling the screen's box, not a 160-pixel crop in the middle.
  img.addEventListener("load", () => {
    const size = grownSize(img.naturalWidth, img.naturalHeight, window.innerWidth - 112, window.innerHeight - 120);
    img.style.width = size ? `${size.w}px` : "";
    img.style.height = size ? `${size.h}px` : "";
  });
  const show = () => {
    img.src = urlOf(pics[k]);
    img.alt = `${what}, picture ${k + 1} of ${pics.length}`;
    count.textContent = pics.length > 1 ? `${k + 1} / ${pics.length}` : "";
    el.querySelectorAll<HTMLButtonElement>(".cv-lb-nav").forEach((b) => { b.hidden = pics.length < 2; });
  };
  const close = () => { el.remove(); if (back?.isConnected) back.focus(); };
  const step = (d: number) => { k = (k + d + pics.length) % pics.length; show(); };
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-lb-close]") || t === el || t.classList.contains("cv-lb-stage")) { close(); return; }
    const nav = t.closest<HTMLElement>("[data-lb]");
    if (nav) step(Number(nav.dataset.lb));
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowRight" && pics.length > 1) { e.preventDefault(); step(1); }
    else if (e.key === "ArrowLeft" && pics.length > 1) { e.preventDefault(); step(-1); }
    e.stopPropagation();
  });
  show();
  el.querySelector<HTMLElement>("[data-lb-close]")!.focus();
}

/** Put the keyboard where you would type to this agent: the chat's composer
 *  when the chat is showing, else its terminal. */
export function focusAgent(pane: Pane): void {
  const box = chatShown(pane) ? pane.el.querySelector<HTMLTextAreaElement>(".cv textarea") : null;
  if (box && box.getClientRects().length) box.focus();
  else pane.term.focus();
}

/** Files dropped on this agent from outside the app: into its message when the chat shows. */
export function dropFilesToAgent(pane: Pane, paths: string[]): boolean {
  const v = views.get(pane.id);
  if (!v?.addFiles || !chatShown(pane) || !v.el.getClientRects().length) return false;
  v.addFiles(paths);
  return true;
}

/** Type text where you would type to this agent (a dropped file's path). */
export function typeToAgent(pane: Pane, text: string): boolean {
  const box = chatShown(pane) ? pane.el.querySelector<HTMLTextAreaElement>(".cv textarea") : null;
  if (!box || !box.getClientRects().length) return false;
  box.setRangeText(text, box.selectionStart, box.selectionEnd, "end");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.focus();
  return true;
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
  v?.off?.();
  if (v) forgetImages(v.chat.items);
  v?.el.remove();
  views.delete(paneId);
}

export function chatShown(pane: Pane): boolean {
  return pane.el.classList.contains("chat-on");
}
