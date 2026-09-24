// Settings modal (Updates row + Hide-to-tray toggle) and the terminal font
// size stepper. Split from main.ts; live-applies font size across every pane
// in every workspace via appstate. `closeSettings` is exported because other
// extracted modules (usage.ts, replay.ts, dashboard.ts-style consumers) call
// it after their own "open" buttons are clicked from inside this modal.

import { setTrayVisible } from "./ipc";
import {
  getHideToTray,
  setHideToTray,
  getTermFontSize,
  setTermFontSize,
  TERM_FONT_DEFAULT,
} from "./settings";
import { confirmModal } from "./confirmmodal";
import { topNote } from "./hint";
import { paneFont } from "./zoom";
import { checkForUpdates } from "./updater";
import { getVersion } from "@tauri-apps/api/app";
import { workspaces } from "./appstate";
import { initPrefsView, resetPrefsView, syncPrefsView } from "./prefsview";

/* ---------------- settings modal ---------------- */
const settingsModal = document.getElementById("settingsModal") as HTMLElement | null;
const setHideTray = document.getElementById("setHideTray") as HTMLInputElement | null;
const setVersion = document.getElementById("setVersion");
const setCheckUpdate = document.getElementById("setCheckUpdate") as HTMLButtonElement | null;

/* ---- terminal font size stepper ---- */
const setFontN = document.getElementById("setFontN");
const TERM_FONT_MIN = 10;
const TERM_FONT_MAX = 20;

function syncFontLabel() {
  const n = getTermFontSize();
  if (setFontN) setFontN.textContent = String(n);
  document.querySelector<HTMLButtonElement>("#setFontStepper [data-dec]")?.toggleAttribute("disabled", n <= TERM_FONT_MIN);
  document.querySelector<HTMLButtonElement>("#setFontStepper [data-inc]")?.toggleAttribute("disabled", n >= TERM_FONT_MAX);
}

function applyTermFontSize(n: number) {
  const clamped = Math.min(TERM_FONT_MAX, Math.max(TERM_FONT_MIN, n));
  setTermFontSize(clamped);
  syncFontLabel();
  // Live-apply to every running pane across all workspaces — through each
  // workspace's own zoom, or a zoomed canvas would snap back to 100% the moment
  // someone nudged this stepper.
  for (const w of workspaces.values()) {
    const font = paneFont(w);
    for (const pane of w.panes.values()) pane.term.setFontSize(font);
  }
}

/** Highlight a settings section's nav item and scroll it into view. Sections
 *  (`.sec[data-sec]`) all live in one scroll column; the nav (`.sn[data-sec]`)
 *  jumps between them — matching the mockup. `scroll` is false on open (the
 *  content is already at the top, no animation needed). */
function navToSection(sec: string, scroll = true): void {
  if (!settingsModal) return;
  settingsModal.querySelectorAll<HTMLElement>(".sn[data-sec]").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.sec === sec);
    if (btn.dataset.sec === sec) btn.setAttribute("aria-current", "true"); else btn.removeAttribute("aria-current");
  });
  if (!scroll) return;
  settingsModal
    .querySelector<HTMLElement>(`.sec[data-sec="${sec}"]`)
    ?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

export function openSettings() {
  if (setHideTray) setHideTray.checked = getHideToTray();
  syncFontLabel();
  syncPrefsView();
  document.getElementById("setContent")?.scrollTo(0, 0);
  navToSection("agents", false); // land on the first section
  if (!settingsModal?.classList.contains("open")) settingsBack = document.activeElement as HTMLElement | null;
  settingsModal?.classList.add("open");
  // The keyboard lands in the dialog (Esc closes it, Tab stays in it).
  document.getElementById("setClose")?.focus();
}
/** Where the keyboard was before Settings opened; it goes back there. */
let settingsBack: HTMLElement | null = null;
export function closeSettings() {
  settingsModal?.classList.remove("open");
  if (settingsBack?.isConnected) settingsBack.focus();
  settingsBack = null;
}

/** Wire the settings modal's open/close controls, the Updates row, the
 *  hide-to-tray toggle, and the font-size stepper. Call once at startup. */
export function initSettingsModal(): void {
  initPrefsView();
  // Show the running version in the Settings "Updates" row.
  void getVersion()
    .then((v) => { if (setVersion) setVersion.textContent = `Maestro · v${v}`; })
    .catch(() => {});

  // Manual update check. Unlike the silent startup check, this one always reports
  // back (up to date / error), and guards against double-clicks while it runs.
  setCheckUpdate?.addEventListener("click", async () => {
    setCheckUpdate.disabled = true;
    const label = setCheckUpdate.textContent;
    setCheckUpdate.textContent = "Checking…";
    try {
      await checkForUpdates(false);
    } finally {
      setCheckUpdate.disabled = false;
      setCheckUpdate.textContent = label;
    }
  });

  document.querySelector("#setFontStepper [data-dec]")?.addEventListener("click", () => {
    applyTermFontSize(getTermFontSize() - 1);
  });
  document.querySelector("#setFontStepper [data-inc]")?.addEventListener("click", () => {
    applyTermFontSize(getTermFontSize() + 1);
  });

  setHideTray?.addEventListener("change", () => {
    const on = setHideTray.checked;
    setHideToTray(on);
    void setTrayVisible(on).catch((e) => console.warn("set tray visibility failed:", e));
  });

  // Reset: everything this page sets, after asking.
  document.getElementById("prefReset")?.addEventListener("click", async () => {
    const r = await confirmModal({
      title: "Reset settings?",
      message: "Agents, Inbox, text size and the tray go back to how Maestro ships. Projects, agents and the remote dashboard are not touched.",
      okLabel: "Reset",
      danger: true,
    });
    if (!r.ok) return;
    resetPrefsView();
    applyTermFontSize(TERM_FONT_DEFAULT);
    if (setHideTray?.checked) { setHideTray.checked = false; setHideTray.dispatchEvent(new Event("change")); }
    topNote("Settings are back to how Maestro ships");
  });

  settingsModal?.querySelectorAll<HTMLElement>(".sn[data-sec]").forEach((btn) => {
    btn.addEventListener("click", () => navToSection(btn.dataset.sec ?? "agents"));
  });

  document.getElementById("btnSettingsHome")?.addEventListener("click", openSettings);
  document.getElementById("cbSettings")?.addEventListener("click", openSettings); // command-bar gear

  document.getElementById("setClose")?.addEventListener("click", closeSettings);
  document.getElementById("setCloseBtn")?.addEventListener("click", closeSettings);
  settingsModal?.addEventListener("mousedown", (e) => {
    if (e.target === settingsModal) closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsModal?.classList.contains("open")) closeSettings();
  });
}
