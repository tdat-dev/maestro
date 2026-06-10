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

/* ---------------- home mascot ---------------- */

export type MascotMode = "move" | "still";
const MASCOT_MODE_KEY = "maestro.mascotMode";

/** How the Home mascot behaves: strolls around ("move") or stays put ("still").
 *  Defaults to "move". */
export function getMascotMode(): MascotMode {
  return localStorage.getItem(MASCOT_MODE_KEY) === "still" ? "still" : "move";
}
export function setMascotMode(mode: MascotMode): void {
  localStorage.setItem(MASCOT_MODE_KEY, mode);
}

const MASCOT_POS_KEY = "maestro.mascotPos";

/** Last hand-placed mascot position (top-left of its box, viewport px), or null. */
export function getMascotPos(): { x: number; y: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(MASCOT_POS_KEY) || "null");
    if (v && typeof v.x === "number" && typeof v.y === "number") return { x: v.x, y: v.y };
  } catch {
    /* ignore */
  }
  return null;
}
export function setMascotPos(x: number, y: number): void {
  localStorage.setItem(MASCOT_POS_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
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
