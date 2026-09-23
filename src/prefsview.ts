// Settings → Agents / Inbox / System rows for Maestro's own settings (prefs.ts).
// The markup is static in index.html; this fills the CLI list, shows the saved
// values when Settings opens, and saves each change the moment it is made.

import { CLI_PRESETS } from "./crew";
import { getPrefs, setPref, resetPrefs, SPLIT_SIZES, type Prefs } from "./prefs";
import { loadCrew, saveSkipPerms } from "./spawnmodal";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

type Toggle = { id: string; key: keyof Prefs };
const TOGGLES: Toggle[] = [
  { id: "prefWorktree", key: "worktree" },
  { id: "prefDirector", key: "directorFirst" },
  { id: "prefNotify", key: "notifyNeeds" },
  { id: "prefJump", key: "jumpToNeeds" },
  { id: "prefAskCard", key: "askCard" },
  { id: "prefReviewOnDone", key: "reviewOnDone" },
  { id: "prefRestore", key: "restore" },
];

function markSeg(id: string, value: number): void {
  $(id)?.querySelectorAll<HTMLButtonElement>("button[data-v]").forEach((b) => {
    const on = Number(b.dataset.v) === value;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

/** Show the saved values. Call when Settings opens. */
export function syncPrefsView(): void {
  const p = getPrefs();
  const cli = $<HTMLSelectElement>("prefDefaultCli");
  if (cli) cli.value = p.defaultCli;
  markSeg("prefDefaultCount", p.defaultCount);
  markSeg("prefSplitMax", p.splitMax);
  const delay = $("prefJobDelay")?.querySelector("[data-n]");
  if (delay) delay.textContent = `${p.jobDelay} s`;
  const ask = $<HTMLInputElement>("prefAsk");
  if (ask) ask.checked = !loadCrew().skipPerms;
  for (const t of TOGGLES) {
    const el = $<HTMLInputElement>(t.id);
    if (el) el.checked = p[t.key] as boolean;
  }
}

/** Wire the rows. Call once at startup. */
export function initPrefsView(): void {
  const cli = $<HTMLSelectElement>("prefDefaultCli");
  if (cli) {
    cli.innerHTML = `<option value="last">Last used</option>` +
      CLI_PRESETS.filter((p) => !p.shell).map((p) => `<option value="${p.id}">${p.label}</option>`).join("");
    cli.addEventListener("change", () => setPref("defaultCli", cli.value));
  }
  $("prefDefaultCount")?.addEventListener("click", (e) => {
    const v = Number((e.target as HTMLElement).closest<HTMLElement>("[data-v]")?.dataset.v);
    if (v === 1 || v === 2 || v === 3) { setPref("defaultCount", v); markSeg("prefDefaultCount", v); }
  });
  $("prefSplitMax")?.addEventListener("click", (e) => {
    const v = Number((e.target as HTMLElement).closest<HTMLElement>("[data-v]")?.dataset.v);
    const size = SPLIT_SIZES.find((n) => n === v);
    if (size) { setPref("splitMax", size); markSeg("prefSplitMax", size); }
  });
  const delay = $("prefJobDelay");
  const step = (d: number) => { setPref("jobDelay", getPrefs().jobDelay + d); syncPrefsView(); };
  delay?.querySelector("[data-dec]")?.addEventListener("click", () => step(-1));
  delay?.querySelector("[data-inc]")?.addEventListener("click", () => step(1));
  const ask = $<HTMLInputElement>("prefAsk");
  ask?.addEventListener("change", () => saveSkipPerms(!ask.checked));
  for (const t of TOGGLES) {
    const el = $<HTMLInputElement>(t.id);
    el?.addEventListener("change", () => setPref(t.key, el.checked as never));
  }
  $("prefReset")?.addEventListener("click", () => {
    resetPrefs();
    saveSkipPerms(false);
    syncPrefsView();
  });
  syncPrefsView();
}
