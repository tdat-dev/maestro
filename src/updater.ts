import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirmDialog } from "./ipc";

/**
 * Check the configured GitHub-Releases endpoint for a newer signed build.
 * On startup pass `silent = true` so a missing endpoint, no update, or being
 * offline stays quiet. When an update exists, ask the user, then download +
 * install + relaunch.
 */
export async function checkForUpdates(silent = true): Promise<void> {
  let update;
  try {
    update = await check();
  } catch (e) {
    if (!silent) console.warn("update check failed:", e);
    return;
  }
  if (!update) return; // already on the latest version (or endpoint had none)

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
  }
}
