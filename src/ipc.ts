import { invoke, Channel } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open, confirm, message } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Open an http(s) link in the user's default browser. */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return; // scheme allowlist matches the capability
  await openUrl(url);
}

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

/* ---- AI Code Slice 2: write side (commit / merge / discard) ---- */

export interface RepoInfo {
  /** Current branch name (empty for detached HEAD). */
  branch: string;
  /** True when this path is a linked worktree, not the main checkout. */
  isWorktree: boolean;
  /** The main repo's working dir when `isWorktree` — where a merge runs. */
  mainRoot: string | null;
  /** True when there are uncommitted changes to commit. */
  dirty: boolean;
}

/** Describe a reviewed repo: branch, worktree status, main root, dirtiness. */
export async function reviewRepoInfo(repoPath: string): Promise<RepoInfo> {
  const r = await invoke<{ branch: string; isWorktree: boolean; mainRoot: string | null; dirty: boolean }>(
    "review_repo_info",
    { repoPath },
  );
  return { branch: r.branch, isWorktree: r.isWorktree, mainRoot: r.mainRoot, dirty: r.dirty };
}

/** Stage all + commit in `worktreePath`. Returns the new commit SHA. */
export async function reviewCommit(worktreePath: string, message: string): Promise<string> {
  return invoke<string>("review_commit", { worktreePath, message });
}

/** Merge `branch` into the current branch of `repoRoot` (--no-ff). Returns the
 *  merge commit SHA; rejects with a structured conflict error on conflict. */
export async function reviewMerge(repoRoot: string, branch: string): Promise<string> {
  return invoke<string>("review_merge", { repoRoot, branch });
}

/** Discard all uncommitted changes in `worktreePath` (revert + clean). */
export async function reviewDiscard(worktreePath: string): Promise<void> {
  await invoke("review_discard", { worktreePath });
}

/** Remove a linked worktree (and optionally delete its branch). Not forced. */
export async function reviewRemoveWorktree(
  repoRoot: string,
  worktreePath: string,
  branch?: string,
): Promise<void> {
  await invoke("review_remove_worktree", { repoRoot, worktreePath, branch: branch ?? null });
}

/** Batch-check whether each program name resolves on PATH (Windows
 *  CreateProcess / PATHEXT semantics). Result is index-aligned with the input.
 *  Used to gray out CLI presets whose binary isn't installed. */
export async function programsOnPath(programs: string[]): Promise<boolean[]> {
  return invoke<boolean[]>("programs_on_path", { programs });
}

/* ---- general filesystem (code panel) ---- */

/** A directory entry from the backend `fs_read_dir`. */
export interface FsEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

/** List one directory level under `root` (path is relative to root, or "."). */
export async function fsReadDir(root: string, path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>("fs_read_dir", { root, path });
}

/** Read a text file (rejects binary/oversize). Returns content + mtime (ms). */
export async function fsReadFile(
  root: string,
  path: string,
): Promise<{ content: string; mtime: number }> {
  return invoke<{ content: string; mtime: number }>("fs_read_file", { root, path });
}

/** Modified-time (ms) probe for external-change detection. */
export async function fsStat(root: string, path: string): Promise<{ mtime: number }> {
  return invoke<{ mtime: number }>("fs_stat", { root, path });
}

/** Write a text file. Pass the last-read mtime to guard against clobbering an
 *  external edit; rejects with a `Conflict` error (carrying the current mtime)
 *  on mismatch. Pass `null` to force-write. Returns the new mtime. */
export async function fsWriteFile(
  root: string,
  path: string,
  content: string,
  expectedMtime: number | null,
): Promise<{ mtime: number }> {
  return invoke<{ mtime: number }>("fs_write_file", { root, path, content, expectedMtime });
}

/** Read an image file as a `data:<mime>;base64,...` URL for inline preview.
 *  Rejects non-image extensions and files over 25 MB. */
export async function fsReadDataUrl(root: string, path: string): Promise<string> {
  return invoke<string>("fs_read_data_url", { root, path });
}
