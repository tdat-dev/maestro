import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { messageDialog } from "./ipc";

/**
 * Check the configured GitHub-Releases endpoint for a newer signed build.
 *
 * `silent = true` (startup) stays quiet on a missing endpoint, no update, or
 * being offline. `silent = false` (the Settings "Check for updates" button)
 * also reports when you're already up to date or when the check fails.
 *
 * When an update exists, a styled toast slides up from the bottom-right (see
 * #updToast) — non-blocking, with a live download progress bar.
 */
export async function checkForUpdates(silent = true): Promise<void> {
  let update;
  try {
    update = await check();
  } catch (e) {
    console.warn("update check failed:", e);
    if (!silent) {
      await messageDialog(`Couldn't check for updates:\n${e}`, "Check for updates", "error");
    }
    return;
  }

  if (!update) {
    if (!silent) {
      const v = await getVersion().catch(() => "");
      await messageDialog(`You're on the latest version${v ? ` (v${v})` : ""}.`, "Check for updates");
    }
    return;
  }

  showUpdateToast(update);
}

/** Show the update toast for `update` and wire its buttons. Safe to call again
 *  (handlers are reassigned, not stacked). */
function showUpdateToast(update: Update): void {
  const $ = (id: string) => document.getElementById(id);
  const toast = $("updToast");
  const title = $("updTitle");
  const ver = $("updVer");
  const bar = $("updBar");
  const fill = $("updBarFill") as HTMLElement | null;
  const actions = $("updActions");
  const goBtn = $("updGo") as HTMLButtonElement | null;
  const laterBtn = $("updLater");
  const dismissBtn = $("updDismiss");
  if (!toast || !title || !ver || !bar || !fill || !actions || !goBtn || !laterBtn || !dismissBtn) return;

  // Reset to the "available" state (in case it was shown/dismissed before).
  title.textContent = "New version available";
  ver.textContent = `Maestro v${update.version}`;
  bar.hidden = true;
  fill.style.width = "0%";
  actions.hidden = false;
  goBtn.disabled = false;

  const hide = () => {
    toast.classList.remove("show");
    window.setTimeout(() => { toast.hidden = true; }, 450); // after the slide-out
  };

  laterBtn.onclick = hide;
  dismissBtn.onclick = hide;
  goBtn.onclick = async () => {
    goBtn.disabled = true;
    laterBtn.hidden = true;
    title.textContent = "Downloading update…";
    bar.hidden = false;
    let total = 0;
    let got = 0;
    try {
      await update.downloadAndInstall((e) => {
        switch (e.event) {
          case "Started":
            total = e.data.contentLength ?? 0;
            break;
          case "Progress":
            got += e.data.chunkLength;
            if (total > 0) {
              fill.style.width = `${Math.min(100, Math.round((got / total) * 100))}%`;
            }
            break;
          case "Finished":
            fill.style.width = "100%";
            title.textContent = "Restarting…";
            break;
        }
      });
      await relaunch();
    } catch (err) {
      console.warn("update install failed:", err);
      title.textContent = "Update failed — try again";
      bar.hidden = true;
      laterBtn.hidden = false;
      goBtn.disabled = false;
    }
  };

  toast.hidden = false;
  // Next frame so the slide-up transition actually animates from the hidden state.
  requestAnimationFrame(() => toast.classList.add("show"));
}
