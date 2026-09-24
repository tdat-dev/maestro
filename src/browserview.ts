// Live view of the browser tab the agent on screen is working in, with Stop.
//
// The hub reports what each agent last did in a browser ("browser-activity").
// While the agent on stage has been browsing within the last minute and a
// half, or has been stopped, a small card sits above the dock, bottom right:
// - a frame of its tab, refreshed about once a second (`browser_peek`, which
//   never brings the tab forward);
// - what it just did, and where;
// - Stop, which refuses the agent's browser calls until you let it go on.
// A click on the frame makes it large.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { topNote } from "./hint";
import { notify } from "./ipc";

export interface Ask { id: number; agent: string; what: string; url: string }
export interface Blocker { agent: string; kind: string; url: string }

export interface Activity { agent: string; browser: number; label: string; tool: string; action: string; at: number; paused: boolean }

const RECENT_MS = 90_000;
const FRAME_MS = 1200;

const VERB: Record<string, string> = {
  tab_new: "Opened a tab", tab_adopt: "Took over a tab", tab_close: "Closed a tab", tabs: "Checked its tabs",
  navigate: "Went to a page", read_page: "Read the page", find: "Looked for something", page_text: "Read the text",
  form_input: "Filled in a field", javascript: "Ran a script on the page", console: "Read the console",
  network: "Read the network log", dialog: "Answered a dialog",
};
const ACTION: Record<string, string> = {
  screenshot: "Took a screenshot", left_click: "Clicked", double_click: "Double-clicked", triple_click: "Clicked",
  right_click: "Right-clicked", hover: "Pointed at something", scroll: "Scrolled", type: "Typed", key: "Pressed a key", wait: "Waited",
};

/** What an agent's last browser step was, in words. */
export function describe(a: Pick<Activity, "tool" | "action">): string {
  if (a.tool === "computer") return ACTION[a.action] ?? "Used the page";
  return VERB[a.tool] ?? "Used the browser";
}

/** The card is up when the agent browsed recently, or you stopped it. */
export function shows(a: Activity | undefined, now: number): boolean {
  return !!a && (a.paused || (a.browser > 0 && now - a.at < RECENT_MS));
}

/** "Ana wants to click "Đăng"", from the hub's `Click "Đăng"`. */
export function askLine(a: Pick<Ask, "agent" | "what">): string {
  return `${a.agent} wants to ${a.what.charAt(0).toLowerCase()}${a.what.slice(1)}`;
}

export function host(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 5 ? "just now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

const svg = (d: string) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
const ICON_FOLD = svg("M6 12h12");
const ICON_OPEN = svg("M6 15l6-6 6 6");

const acts = new Map<string, Activity>();
let card: HTMLElement | null = null;
let shownFor = "";
let small = false; // folded down to a chip
let busy = false;
let lastFrame = 0;

function stageAgent(): string {
  return document.querySelector(".pane.focused .pb-name")?.textContent?.trim() ?? "";
}

function build(): HTMLElement {
  const el = document.createElement("section");
  el.className = "bv";
  el.setAttribute("role", "region");
  el.innerHTML = `
    <header class="bv-head">
      <span class="bv-dot" aria-hidden="true"></span>
      <span class="bv-t"><b data-bv-name></b><span data-bv-where></span></span>
      <button type="button" class="bv-ic" data-bv-fold aria-label="Fold the live view" title="Fold"></button>
    </header>
    <button type="button" class="bv-frame" data-bv-big aria-label="Make the live view larger">
      <img alt="" data-bv-img />
      <span class="bv-note" data-bv-note hidden></span>
    </button>
    <footer class="bv-foot">
      <span class="bv-what" data-bv-what aria-live="polite"></span>
      <button type="button" class="bv-stop" data-bv-stop></button>
    </footer>`;
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-bv-fold]")) { small = !small; paint(); if (!small) void frame(true); }
    else if (t.closest("[data-bv-big]")) el.classList.toggle("big");
    else if (t.closest("[data-bv-stop]")) void toggleStop();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el.classList.contains("big")) { el.classList.remove("big"); e.stopPropagation(); }
  });
  document.body.append(el);
  return el;
}

async function toggleStop() {
  const a = acts.get(shownFor);
  if (!a) return;
  const paused = !a.paused;
  try {
    await invoke("browser_pause", { agent: a.agent, paused });
    topNote(paused ? `${a.agent} can't use the browser until you let it go on.` : `${a.agent} can use the browser again.`);
  } catch (e) {
    topNote(String(e));
  }
}

function paint() {
  const name = stageAgent();
  const a = acts.get(name);
  const on = shows(a, Date.now());
  if (!on) {
    if (card) card.hidden = true;
    shownFor = "";
    return;
  }
  card ??= build();
  const changed = shownFor !== name;
  shownFor = name;
  card.hidden = false;
  card.classList.toggle("folded", small);
  card.classList.toggle("paused", a!.paused);
  card.setAttribute("aria-label", `${name}'s browser`);
  card.querySelector("[data-bv-name]")!.textContent = name;
  card.querySelector("[data-bv-where]")!.textContent = a!.label ? ` · ${a!.label}` : "";
  const what = a!.paused ? "Stopped by you" : `${describe(a!)} · ${ago(Date.now() - a!.at)}`;
  const whatEl = card.querySelector("[data-bv-what]")!;
  if (whatEl.textContent !== what) whatEl.textContent = what;
  const stop = card.querySelector<HTMLButtonElement>("[data-bv-stop]")!;
  stop.textContent = a!.paused ? "Let it go on" : "Stop";
  stop.setAttribute("aria-label", a!.paused ? `Let ${name} use the browser again` : `Stop ${name} using the browser`);
  const fold = card.querySelector<HTMLElement>("[data-bv-fold]")!;
  if (fold.dataset.small !== String(small)) {
    fold.dataset.small = String(small);
    fold.innerHTML = small ? ICON_OPEN : ICON_FOLD;
    fold.setAttribute("aria-label", small ? "Show the live view" : "Fold the live view");
    fold.title = small ? "Show" : "Fold";
  }
  if (changed) {
    card.querySelector<HTMLImageElement>("[data-bv-img]")!.removeAttribute("src");
    card.classList.remove("big");
    void frame(true);
  }
}

async function frame(now = false) {
  if (!card || card.hidden || small || busy || document.visibilityState !== "visible") return;
  if (!now && Date.now() - lastFrame < FRAME_MS) return;
  const agent = shownFor;
  busy = true;
  try {
    const r = await invoke<{ content: { type: string; data?: string }[]; tab?: { url: string; title: string } }>("browser_peek", { agent });
    if (agent !== shownFor || !card) return;
    const img = r.content.find((c) => c.type === "image");
    if (img?.data) {
      const el = card.querySelector<HTMLImageElement>("[data-bv-img]")!;
      el.src = `data:image/jpeg;base64,${img.data}`;
      el.alt = `${agent}'s tab${r.tab?.title ? `: ${r.tab.title}` : ""}`;
    }
    note("");
  } catch (e) {
    note(/isn't showing/.test(String(e)) ? "The tab is in the background" : "No picture right now");
  } finally {
    busy = false;
    lastFrame = Date.now();
  }
}

function note(text: string) {
  const n = card?.querySelector<HTMLElement>("[data-bv-note]");
  if (!n) return;
  n.textContent = text;
  n.hidden = !text;
}

// ---- clicks held for your OK (sending, posting, paying, deleting)

let asksBox: HTMLElement | null = null;
const told = new Set<number>();

function renderAsks(list: Ask[]) {
  asksBox ??= Object.assign(document.createElement("div"), { className: "bv-asks" });
  if (!asksBox.isConnected) document.body.append(asksBox);
  const had = new Set([...asksBox.querySelectorAll<HTMLElement>("[data-ask]")].map((e) => Number(e.dataset.ask)));
  asksBox.replaceChildren(
    ...list.map((a) => {
      const el = document.createElement("section");
      el.className = "bv-ask";
      el.dataset.ask = String(a.id);
      el.setAttribute("role", "alertdialog");
      el.setAttribute("aria-label", askLine(a));
      el.innerHTML = `<span class="bv-dot" aria-hidden="true"></span><div class="bv-ask-t"><b></b><span></span></div><div class="bv-ask-acts"><button type="button" class="bv-no" data-no>Don't allow</button><button type="button" class="bv-ok" data-ok>Allow</button></div>`;
      el.querySelector("b")!.textContent = askLine(a);
      el.querySelector(".bv-ask-t span")!.textContent = host(a.url) ? `on ${host(a.url)}` : "in the browser";
      return el;
    }),
  );
  for (const a of list) {
    if (had.has(a.id) || told.has(a.id)) continue;
    told.add(a.id);
    if (!document.hasFocus()) void notify(askLine(a), `${host(a.url) ? `On ${host(a.url)}. ` : ""}Open Maestro to allow it or not.`).catch(() => {});
  }
  // A new ask takes the keyboard only when nothing else has it.
  const first = asksBox.querySelector<HTMLButtonElement>("[data-no]");
  if (first && list.some((a) => !had.has(a.id)) && (document.activeElement === document.body || !document.activeElement)) first.focus();
}

const seenBlockers = new Map<string, number>();

function onBlocker(b: Blocker) {
  const key = `${b.agent}|${b.kind}|${b.url}`;
  if (Date.now() - (seenBlockers.get(key) ?? 0) < 120_000) return;
  seenBlockers.set(key, Date.now());
  const what = b.kind === "captcha" ? "a CAPTCHA" : "a login page";
  const where = host(b.url) ? ` on ${host(b.url)}` : "";
  topNote(`<b>${esc(b.agent)}</b> reached ${what}${esc(where)}. Handle it in Chrome, then tell it to carry on.`, 6000);
  if (!document.hasFocus()) void notify(`${b.agent} needs you in Chrome`, `It reached ${what}${where}.`).catch(() => {});
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function initBrowserView(): void {
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const card = t.closest<HTMLElement>(".bv-ask");
    if (!card) return;
    const ok = !!t.closest("[data-ok]");
    if (!ok && !t.closest("[data-no]")) return;
    void invoke("browser_answer", { id: Number(card.dataset.ask), ok }).catch((err) => topNote(String(err)));
  });
  void invoke<Ask[]>("browser_asks").then(renderAsks).catch(() => {});
  void listen<Ask[]>("browser-asks", (e) => renderAsks(e.payload));
  void listen<Blocker>("browser-blocker", (e) => onBlocker(e.payload));
  void invoke<Activity[]>("browser_activity")
    .then((list) => { for (const a of list) acts.set(a.agent, a); paint(); })
    .catch(() => {});
  void listen<Activity[]>("browser-activity", (e) => {
    acts.clear();
    for (const a of e.payload) acts.set(a.agent, a);
    paint();
    void frame();
  });
  // Follows the stage and keeps "3s ago" true, frames about once a second.
  setInterval(() => { paint(); void frame(); }, 1000);
}
