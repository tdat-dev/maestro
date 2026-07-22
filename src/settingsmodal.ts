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
} from "./settings";
import { checkForUpdates } from "./updater";
import { getVersion } from "@tauri-apps/api/app";
import { workspaces } from "./appstate";

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
  if (setFontN) setFontN.textContent = String(getTermFontSize());
}

function applyTermFontSize(n: number) {
  const clamped = Math.min(TERM_FONT_MAX, Math.max(TERM_FONT_MIN, n));
  setTermFontSize(clamped);
  syncFontLabel();
  // Live-apply to every running pane across all workspaces.
  for (const w of workspaces.values())
    for (const pane of w.panes.values()) pane.term.setFontSize(clamped);
}

/** Show one settings section (Appearance/Fleet/Sessions/System) and mark its
 *  nav item active. The nav + panes are paired by data-setnav / data-setpane. */
function showSettingsPane(key: string): void {
  if (!settingsModal) return;
  settingsModal.querySelectorAll<HTMLElement>("[data-setnav]").forEach((btn) => {
    const on = btn.dataset.setnav === key;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  settingsModal.querySelectorAll<HTMLElement>("[data-setpane]").forEach((pane) => {
    pane.hidden = pane.dataset.setpane !== key;
  });
}

export function openSettings() {
  if (setHideTray) setHideTray.checked = getHideToTray();
  syncFontLabel();
  showSettingsPane("appearance"); // always land on the first section
  settingsModal?.classList.add("open");
}
export function closeSettings() {
  settingsModal?.classList.remove("open");
}

/** Wire the settings modal's open/close controls, the Updates row, the
 *  hide-to-tray toggle, and the font-size stepper. Call once at startup. */
export function initSettingsModal(): void {
  // Show the running version in the Settings "Updates" row.
  void getVersion()
    .then((v) => { if (setVersion) setVersion.textContent = `Maestro v${v}`; })
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

  settingsModal?.querySelectorAll<HTMLElement>("[data-setnav]").forEach((btn) => {
    btn.addEventListener("click", () => showSettingsPane(btn.dataset.setnav ?? "appearance"));
  });

  document.getElementById("btnSettings")?.addEventListener("click", openSettings);
  document.getElementById("btnSettingsHome")?.addEventListener("click", openSettings);
  document.getElementById("setClose")?.addEventListener("click", closeSettings);
  document.getElementById("setCloseBtn")?.addEventListener("click", closeSettings);
  settingsModal?.addEventListener("mousedown", (e) => {
    if (e.target === settingsModal) closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsModal?.classList.contains("open")) closeSettings();
  });
}
