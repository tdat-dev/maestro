/* User settings persisted in localStorage. Single source of truth for the key
 * strings so callers and tests can't drift apart. */

const HIDE_TO_TRAY_KEY = "maestro.hideToTray";

/** Whether closing/minimizing should hide the window to the system tray
 *  instead of quitting / minimizing to the taskbar. Defaults to off. */
export function getHideToTray(): boolean {
  return localStorage.getItem(HIDE_TO_TRAY_KEY) === "1";
}

export function setHideToTray(on: boolean): void {
  if (on) localStorage.setItem(HIDE_TO_TRAY_KEY, "1");
  else localStorage.removeItem(HIDE_TO_TRAY_KEY);
}

/* ---------------- terminal font size ---------------- */

const TERM_FONT_SIZE_KEY = "maestro.termFontSize";
const TERM_FONT_MIN = 10;
const TERM_FONT_MAX = 20;
const TERM_FONT_DEFAULT = 13;

function clampFont(n: number): number {
  if (!Number.isFinite(n)) return TERM_FONT_DEFAULT;
  return Math.min(TERM_FONT_MAX, Math.max(TERM_FONT_MIN, Math.round(n)));
}

/** Terminal font size in px. Defaults to 13, clamped to 10..20. */
export function getTermFontSize(): number {
  const raw = localStorage.getItem(TERM_FONT_SIZE_KEY);
  if (raw === null) return TERM_FONT_DEFAULT;
  return clampFont(Number(raw));
}

export function setTermFontSize(n: number): void {
  localStorage.setItem(TERM_FONT_SIZE_KEY, String(clampFont(n)));
}

const TRAY_NOTICE_KEY = "maestro.trayNoticeShown";

/** Whether the "still running in the tray" notice has been shown before — it
 *  only needs to appear the first time the window hides, to avoid confusion. */
export function trayNoticeShown(): boolean {
  return localStorage.getItem(TRAY_NOTICE_KEY) === "1";
}

export function markTrayNoticeShown(): void {
  localStorage.setItem(TRAY_NOTICE_KEY, "1");
}
