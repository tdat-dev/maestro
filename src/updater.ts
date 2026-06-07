import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { confirmDialog, messageDialog } from "./ipc";

/**
 * Check the configured GitHub-Releases endpoint for a newer signed build.
 *
 * `silent = true` (startup) stays quiet on a missing endpoint, no update, or
 * being offline. `silent = false` (the Settings "Check for updates" button)
 * also tells the user when they're already up to date or when the check fails,
 * so the button always gives feedback.
 *
 * When an update exists, ask the user, then download + install + relaunch.
 */
export async function checkForUpdates(silent = true): Promise<void> {
  let update;
  try {
    update = await check();
  } catch (e) {
    console.warn("update check failed:", e);
    if (!silent) {
      await messageDialog(
        `Couldn't check for updates:\n${e}`,
        "Check for updates",
        "error",
      );
    }
    return;
  }

  if (!update) {
    // Already on the latest version (or the endpoint has nothing newer).
    if (!silent) {
      const v = await getVersion().catch(() => "");
      await messageDialog(
        `You're on the latest version${v ? ` (v${v})` : ""}.`,
        "Check for updates",
      );
    }
    return;
  }

  const ok = await confirmDialog(
    `Update ${update.version} is available. Download and install now? Maestro will restart.`,
    "Update available",
  );
  if (!ok) return;

  try {
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    console.warn("update install failed:", e);
    if (!silent) {
      await messageDialog(`Update failed:\n${e}`, "Check for updates", "error");
    }
  }
}
