import {
  minimizeWindow,
  toggleMaximizeWindow,
  requestCloseWindow,
  isWindowMaximized,
  onWindowResized,
} from "./ipc";

const MAX_ICON =
  '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><rect x="0.5" y="0.5" width="9" height="9"/></svg>';
const RESTORE_ICON =
  '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><rect x="0.5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V0.5h7v7H7"/></svg>';

/** Wire the frameless title-bar controls (minimize / maximize-restore / close).
 *  Self-contained: depends only on the window ipc wrappers. */
export function initTitlebar(): void {
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

  document.getElementById("wcMin")?.addEventListener("click", () => void minimizeWindow());
  wcMaxBtn?.addEventListener("click", async () => {
    await toggleMaximizeWindow();
    await refreshMaxIcon();
  });
  document.getElementById("wcClose")?.addEventListener("click", () => void requestCloseWindow());
  void refreshMaxIcon();
  void onWindowResized(refreshMaxIcon).catch(() => {});
}
