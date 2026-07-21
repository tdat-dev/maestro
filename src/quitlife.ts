// Close / quit / hide-to-tray. The X button, tray "Quit", and a detached
// window's own close all funnel through here. A full quit confirms once for
// every running terminal (main + every detached window), kills them all, then
// destroys the window; closing just the main window while detached windows
// stay open only kills its own panes and hides it (so the tray icon lives on
// for those other windows). Split from main.ts; fully self-contained — no
// injected deps, everything it needs is imported directly.

import { workspaces } from "./appstate";
import {
  killAll,
  killPty,
  onWindowClose,
  confirmDialog,
  destroyWindow,
  hideWindow,
  setTrayVisible,
  onTrayQuit,
  broadcastQuit,
  onAppQuit,
} from "./ipc";
import { getHideToTray } from "./settings";
import { needsCloseConfirm } from "./workspaces";
import { saveSession, detachedSessionCount, sessionKey } from "./session";

// A detached window (a tab dragged out of another Maestro window) boots with
// ?detach=<key>. Mirrors main.ts's own DETACH_KEY/isDetachedWindow (computed
// independently — both read the same URL, so they always agree).
const isDetachedWindow = new URLSearchParams(location.search).get("detach") !== null;

let closing = false;

function ownPaneCount(): number {
  let total = 0;
  for (const w of workspaces.values()) total += w.panes.size;
  return total;
}

/** Full quit (MAIN window): confirm if terminals are running anywhere, kill
 *  them all, tell detached windows to close, destroy. Used by the X button
 *  (when hide-to-tray is off) and the tray "Quit". */
async function quitApp(): Promise<void> {
  if (closing) return;
  const total = ownPaneCount() + detachedSessionCount();
  if (needsCloseConfirm(total)) {
    const ok = await confirmDialog(`${total} running terminal(s) will be killed. Quit Maestro?`, "Quit Maestro");
    if (!ok) return;
  }
  closing = true;
  try {
    await killAll();
  } catch {
    /* ignore */
  }
  // Detached windows die with the app (their agents were just killed).
  try {
    await broadcastQuit();
  } catch {
    /* ignore */
  }
  await destroyWindow();
}

/** Close a DETACHED window: kill only ITS agents, drop its session key, and
 *  leave every other Maestro window untouched. */
async function closeDetachedWindow(): Promise<void> {
  if (closing) return;
  const total = ownPaneCount();
  if (needsCloseConfirm(total)) {
    const ok = await confirmDialog(`${total} running terminal(s) will be killed. Close this window?`, "Close window");
    if (!ok) return;
  }
  closing = true;
  for (const w of workspaces.values()) {
    for (const id of w.panes.keys()) {
      try {
        await killPty(id);
      } catch {
        /* ignore */
      }
    }
  }
  localStorage.removeItem(sessionKey); // nothing to sweep on next launch
  await destroyWindow();
}

/** Wire the window-close handler, the app-quit/tray-quit listeners, and mirror
 *  the tray icon's boot-time visibility to the saved setting. Call once at
 *  startup. */
export function initQuitLife(): void {
  // The X button always quits this window (with a kill confirm when terminals
  // run). "Hide to tray" is bound to the minimize button instead — see titlebar.ts.
  void onWindowClose(async (event) => {
    if (closing) return;
    event.preventDefault();

    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const allWindows = await WebviewWindow.getAll();
    let visibleCount = 0;
    for (const w of allWindows) {
      if (await w.isVisible()) visibleCount++;
    }

    // If this is the last visible window, quit the app completely.
    if (visibleCount <= 1) {
      await quitApp();
      return;
    }

    // Otherwise, just close THIS window.
    if (isDetachedWindow) {
      await closeDetachedWindow();
    } else {
      // The main window is closing, but detached windows are still active.
      // We shouldn't destroy the main window (breaks the tray icon).
      // Just kill its PTYs, clear workspaces, and hide it.
      const total = ownPaneCount();
      if (needsCloseConfirm(total)) {
        const ok = await confirmDialog(`${total} running terminal(s) will be killed. Close this window?`, "Close window");
        if (!ok) return;
      }
      closing = true;
      for (const w of workspaces.values()) {
        for (const id of w.panes.keys()) {
          try { await killPty(id); } catch {}
        }
      }
      workspaces.clear();
      saveSession();
      await hideWindow();
      closing = false;
    }
  }).catch((e) => console.warn("close handler unavailable:", e));

  if (isDetachedWindow) {
    // Main quit (X / tray) broadcasts after its kill-all — just fold this window.
    // The session key is left in place ON PURPOSE: the next launch's main window
    // sweeps it back into a (stopped) tab, same as the main window's own tabs.
    void onAppQuit(() => {
      closing = true;
      void destroyWindow();
    }).catch((e) => console.warn("app-quit listener unavailable:", e));
  } else {
    // Tray "Quit" → same full-quit flow (Rust already re-showed the window so the
    // confirm dialog is visible).
    void onTrayQuit(() => quitApp()).catch((e) => console.warn("tray-quit listener unavailable:", e));

    // Mirror the tray icon's visibility to the saved setting on boot.
    void setTrayVisible(getHideToTray()).catch((e) => console.warn("set tray visibility failed:", e));
  }
}
