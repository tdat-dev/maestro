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

const TRAY_NOTICE_KEY = "maestro.trayNoticeShown";

/** Whether the "still running in the tray" notice has been shown before — it
 *  only needs to appear the first time the window hides, to avoid confusion. */
export function trayNoticeShown(): boolean {
  return localStorage.getItem(TRAY_NOTICE_KEY) === "1";
}

export function markTrayNoticeShown(): void {
  localStorage.setItem(TRAY_NOTICE_KEY, "1");
}
