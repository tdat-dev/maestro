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

export function initBrowserView(): void {
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
