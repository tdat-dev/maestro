// Settings → Browser: which of the user's browser profiles their agents can
// use, and the three steps to add "Maestro for Chrome" to one. A profile's row
// turns to Connected by itself when its extension reaches the hub (the
// "browser-hub" event), so setup needs no "check again" button.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { topNote } from "./hint";

interface Profile { browser: string; dir: string; name: string; email: string }
interface Connected { id: number; browser: string; email: string; profile: string; version: string }
interface Status { running: boolean; browsers: Connected[]; extension_dir: string }

const list = () => document.getElementById("bpList");
const setup = () => document.getElementById("bpSetup");

let profiles: Profile[] = [];
let connected: Connected[] = [];
let extDir = "";
/** The profile the setup steps are open for. */
let settingUp: Profile | null = null;

const short = (browser: string) => browser.replace(/^Google |^Microsoft /, "");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const same = (p: Profile, c: Connected) => !!p.email && p.email.toLowerCase() === c.email.toLowerCase() && c.browser === p.browser;

function render() {
  const ul = list();
  if (!ul) return;
  const matched = new Set<number>();
  const rows = profiles.map((p, i) => {
    const c = connected.find((x) => same(p, x));
    if (c) matched.add(c.id);
    const sub = [p.email || "Not signed in", short(p.browser)].join(" · ");
    const right = c
      ? `<span class="bp-on"><i aria-hidden="true"></i>Connected</span>`
      : `<button type="button" class="sbtn" data-setup="${i}" aria-label="Set up ${esc(p.name)}">Set up</button>`;
    return `<li class="bp-row${c ? " on" : ""}"><span class="bp-av" aria-hidden="true">${esc((p.name.trim()[0] ?? "?").toUpperCase())}</span><span class="bp-txt"><b>${esc(p.name)}</b><span>${esc(sub)}</span></span>${right}</li>`;
  });
  // Connected profiles we can't name (not signed in to the browser).
  for (const c of connected) {
    if (matched.has(c.id)) continue;
    rows.push(`<li class="bp-row on"><span class="bp-av" aria-hidden="true">${esc(short(c.browser)[0] ?? "?")}</span><span class="bp-txt"><b>${esc(c.profile || "A profile")}</b><span>${esc(c.email || "Not signed in")} · ${esc(short(c.browser))}</span></span><span class="bp-on"><i aria-hidden="true"></i>Connected</span></li>`);
  }
  ul.innerHTML = rows.length ? rows.join("") : `<li class="bp-empty">No Chrome, Edge or Brave profiles on this computer.</li>`;

  const box = setup();
  if (!box) return;
  if (settingUp && connected.some((c) => same(settingUp!, c))) {
    topNote(`${settingUp.name} is connected. Your agents can use it now.`);
    settingUp = null;
  }
  box.hidden = !settingUp;
  if (settingUp) {
    box.querySelector("[data-bp-name]")!.textContent = settingUp.name;
    box.querySelectorAll("[data-bp-browser]").forEach((n) => (n.textContent = short(settingUp!.browser)));
    box.querySelector("[data-bp-dir]")!.textContent = extDir;
  }
}

export async function refreshBrowserPrefs(): Promise<void> {
  try {
    const [p, s] = await Promise.all([invoke<Profile[]>("browser_profiles"), invoke<Status>("browser_status")]);
    profiles = p;
    connected = s.browsers;
    extDir = s.extension_dir;
  } catch (e) {
    console.warn("browser settings:", e);
  }
  render();
}

async function copy(text: string, btn: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text);
    const was = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = was), 1400);
  } catch {
    topNote("Couldn't copy. Select the text and press Ctrl+C.");
  }
}

export function initBrowserPrefs(): void {
  void listen<Connected[]>("browser-hub", (e) => {
    connected = e.payload;
    render();
  });
  list()?.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-setup]");
    if (!b) return;
    settingUp = profiles[Number(b.dataset.setup)] ?? null;
    render();
    if (!settingUp) return;
    try {
      await invoke("browser_open_profile", { browser: settingUp.browser, dir: settingUp.dir });
    } catch (err) {
      topNote(String(err));
    }
    setup()?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
  setup()?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
    if (b) void copy(b.dataset.copy === "dir" ? extDir : b.dataset.copy!, b);
    if ((e.target as HTMLElement).closest("[data-bp-done]")) {
      settingUp = null;
      render();
    }
  });
}
