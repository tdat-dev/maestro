import {
  minimizeWindow,
  toggleMaximizeWindow,
  requestCloseWindow,
  isWindowMaximized,
  onWindowResized,
  hideWindow,
  notify,
} from "./ipc";
import { getHideToTray, trayNoticeShown, markTrayNoticeShown } from "./settings";

/** Tuck the window into the tray and, the first time only, tell the user the
 *  app is still alive so they don't think it quit. */
async function hideToTray(): Promise<void> {
  await hideWindow();
  if (!trayNoticeShown()) {
    markTrayNoticeShown();
    void notify(
      "Maestro is still running",
      "Open it from the system tray, or right-click the tray icon to quit.",
    ).catch(() => {});
  }
}

const MAX_ICON =
  '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><rect x="0.5" y="0.5" width="9" height="9"/></svg>';
const RESTORE_ICON =
  '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><rect x="0.5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V0.5h7v7H7"/></svg>';

/** Wire the frameless title-bar controls (minimize / maximize-restore / close).
 *  Self-contained: depends only on the window ipc wrappers.
 *  `allowHideToTray=false` (detached windows): minimize ALWAYS minimizes — the
 *  tray can only re-show the MAIN window, so hiding a detached one loses it. */
export function initTitlebar(allowHideToTray = true): void {
  const wcMaxBtn = document.getElementById("wcMax");

  async function refreshMaxIcon() {
    if (!wcMaxBtn) return;
    try {
      const max = await isWindowMaximized();
      wcMaxBtn.innerHTML = max ? RESTORE_ICON : MAX_ICON;
      wcMaxBtn.setAttribute("aria-label", max ? "Restore" : "Maximize");
    } catch {
      /* not in Tauri (browser preview) */
    }
  }

  document.getElementById("wcMin")?.addEventListener("click", () => {
    // When "Hide to tray" is on, the minimize button tucks the window into the
    // tray instead of dropping it to the taskbar. (The X button always quits.)
    void (allowHideToTray && getHideToTray() ? hideToTray() : minimizeWindow());
  });
  wcMaxBtn?.addEventListener("click", async () => {
    await toggleMaximizeWindow();
    await refreshMaxIcon();
  });
  document.getElementById("wcClose")?.addEventListener("click", () => void requestCloseWindow());
  void refreshMaxIcon();
  void onWindowResized(refreshMaxIcon).catch(() => {});
}
