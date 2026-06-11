import { invoke, Channel } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open, confirm, message } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

/**
 * Thin wrappers around the Tauri pty_* commands. Every call is addressed to a
 * specific agent by `agentId`, so many agents run concurrently.
 */
export async function spawnPty(
  agentId: string,
  program: string,
  args: string[],
  cwd: string | null,
  cols: number,
  rows: number,
  onBytes: (bytes: Uint8Array) => void,
): Promise<void> {
  // PTY output streams as raw binary (ArrayBuffer), NOT a JSON number[]. The
  // number[] path serialized every byte as a JSON number on both sides and
  // choked the whole app under a chatty fleet; a raw buffer is ~100x cheaper.
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (buf) => onBytes(new Uint8Array(buf));
  await invoke("pty_spawn", { agentId, program, args, cwd, cols, rows, onBytes: ch });
}

/** Re-attach a RUNNING agent's output to this window (tab detach hand-off).
 *  The backend replays its buffered scrollback through the channel first, then
 *  streams live output. Rejects if the agent no longer exists. */
export async function attachPty(
  agentId: string,
  onBytes: (bytes: Uint8Array) => void,
): Promise<void> {
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (buf) => onBytes(new Uint8Array(buf));
  await invoke("pty_attach", { agentId, onBytes: ch });
}

export async function sendInput(agentId: string, data: string): Promise<void> {
  await invoke("pty_input", { agentId, data });
}

export async function resizePty(agentId: string, cols: number, rows: number): Promise<void> {
  await invoke("pty_resize", { agentId, cols, rows });
}

export async function killPty(agentId: string): Promise<void> {
  await invoke("pty_kill", { agentId });
}

export async function killAll(): Promise<void> {
  await invoke("pty_kill_all");
}

export async function onExit(cb: (agentId: string, code: number) => void): Promise<UnlistenFn> {
  return listen<{ id: string; code: number }>("pty-exit", (e) => cb(e.payload.id, e.payload.code));
}

/** A file drag-drop event from the OS. `leave` carries no paths/position. */
export type DropPayload =
  | { type: "enter" | "over" | "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

/** Subscribe to OS file drag-drop over the window (enter/over/drop/leave).
 *  Positions are physical pixels — divide by devicePixelRatio for CSS coords. */
export async function onDragDrop(cb: (p: DropPayload) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((e) => cb(e.payload as DropPayload));
}

/** Native folder picker. Returns the chosen directory, or null if cancelled. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const res = await open({ directory: true, multiple: false, defaultPath });
  return typeof res === "string" ? res : null;
}

/** Native confirm dialog. Returns true if the user accepts. */
export async function confirmDialog(message: string, title: string): Promise<boolean> {
  return confirm(message, { title, kind: "warning" });
}

/** Native single-button message dialog (info/up-to-date/error feedback). */
export async function messageDialog(
  text: string,
  title: string,
  kind: "info" | "warning" | "error" = "info",
): Promise<void> {
  await message(text, { title, kind });
}

/** Register a handler for the window's close (X) button. Call event.preventDefault()
 *  inside to keep the window open. */
export async function onWindowClose(
  handler: (event: { preventDefault(): void }) => void | Promise<void>,
): Promise<void> {
  await getCurrentWindow().onCloseRequested(handler);
}

/** Force the window closed without re-firing onCloseRequested. */
export async function destroyWindow(): Promise<void> {
  await getCurrentWindow().destroy();
}

/** Hide the window (used by the "Hide to tray" flow — keeps agents running). */
export async function hideWindow(): Promise<void> {
  await getCurrentWindow().hide();
}

/** Show or hide the system-tray icon (mirrors the "Hide to tray" setting). */
export async function setTrayVisible(visible: boolean): Promise<void> {
  await invoke("set_tray_visible", { visible });
}

/** Set the tray icon's hover tooltip (e.g. live agent count). */
export async function setTrayTooltip(tooltip: string): Promise<void> {
  await invoke("set_tray_tooltip", { tooltip });
}

/** Fire a one-shot OS notification (asks for permission once if needed). */
export async function notify(title: string, body: string): Promise<void> {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (granted) sendNotification({ title, body });
}

/** Fire `cb` when the tray menu's "Quit" item is chosen. */
export async function onTrayQuit(cb: () => void | Promise<void>): Promise<UnlistenFn> {
  return listen("tray-quit", () => void cb());
}

/* ---- detached (multi-window) support ---- */

/** Open a new Maestro window that boots straight into a detached workspace.
 *  `key` selects the localStorage hand-off payload (`maestro.detach.<key>`).
 *  Resolves once the window exists; rejects if creation fails. */
export async function openDetachWindow(key: string, title: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = new WebviewWindow(`detach-${key}`, {
      url: `/?detach=${encodeURIComponent(key)}`,
      title,
      width: 1100,
      height: 720,
      minWidth: 760,
      minHeight: 540,
      resizable: true,
      decorations: false,
    });
    void w.once("tauri://created", () => resolve());
    void w.once("tauri://error", (e) => reject(e.payload));
  });
}

/** App-wide "quit now" broadcast: the main window fires this after its kill-all
 *  so detached windows close themselves too. */
export async function broadcastQuit(): Promise<void> {
  await emit("maestro-quit");
}

/** Fire `cb` when the main window broadcasts the app quit. */
export async function onAppQuit(cb: () => void | Promise<void>): Promise<UnlistenFn> {
  return listen("maestro-quit", () => void cb());
}

/** Broadcast an app-wide event to every Maestro window. */
export async function emitAppEvent(name: string, payload: unknown): Promise<void> {
  await emit(name, payload);
}

/** Listen for an app-wide event; resolves to an unlisten fn. */
export async function onAppEvent<T>(name: string, cb: (payload: T) => void): Promise<() => void> {
  return listen<T>(name, (e) => cb(e.payload));
}

/** Bring this window to the front (restore + focus). */
export async function focusThisWindow(): Promise<void> {
  const w = getCurrentWindow();
  await w.unminimize().catch(() => {});
  await w.setFocus();
}

/* ---- custom title-bar window controls (frameless) ---- */
export async function minimizeWindow(): Promise<void> {
  await getCurrentWindow().minimize();
}
export async function toggleMaximizeWindow(): Promise<void> {
  await getCurrentWindow().toggleMaximize();
}
/** Ask to close — fires onCloseRequested so the confirm + kill-all flow runs. */
export async function requestCloseWindow(): Promise<void> {
  await getCurrentWindow().close();
}
export async function isWindowMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized();
}
/** Run `cb` whenever the window is resized (incl. maximize/restore). */
export async function onWindowResized(cb: () => void): Promise<void> {
  await getCurrentWindow().onResized(() => cb());
}

/** Repo root if `dir` is inside a single git repo, else null. */
export async function gitRepoRoot(dir: string): Promise<string | null> {
  const r = await invoke<string | null>("git_repo_root", { dir });
  return r ?? null;
}

/** Create a worktree on `branch` off HEAD of `repoRoot`; returns its path. */
export async function worktreeAdd(repoRoot: string, branch: string): Promise<string> {
  return invoke<string>("worktree_add", { repoRoot, branch });
}

/** Remove a worktree (optionally deleting its branch). */
export async function worktreeRemove(
  repoRoot: string,
  path: string,
  branch?: string,
): Promise<void> {
  await invoke("worktree_remove", { repoRoot, path, branch: branch ?? null });
}

export interface RepoRef { path: string; name: string }

/** Git repos to review under `dir` (the dir itself, or its sub-repos). */
export async function reposUnder(dir: string): Promise<RepoRef[]> {
  return invoke<RepoRef[]>("git_repos_under", { dir });
}

/** Raw unified diff of a repo's working tree vs HEAD. */
export async function repoDiff(repoRoot: string): Promise<string> {
  return invoke<string>("repo_diff", { repoRoot });
}
