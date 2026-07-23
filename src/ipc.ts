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
  env: Array<[string, string]>,
  onBytes: (bytes: Uint8Array) => void,
): Promise<void> {
  // PTY output streams as raw binary (ArrayBuffer), NOT a JSON number[]. The
  // number[] path serialized every byte as a JSON number on both sides and
  // choked the whole app under a chatty fleet; a raw buffer is ~100x cheaper.
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (buf) => onBytes(new Uint8Array(buf));
  await invoke("pty_spawn", { agentId, program, args, cwd, cols, rows, env, onBytes: ch });
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

/* ---- local web dashboard ---- */

export interface DashboardInfo {
  running: boolean;
  port: number;
  lan: boolean;
  urls: string[];
}

export async function dashboardStatus(): Promise<DashboardInfo> {
  return invoke<DashboardInfo>("dashboard_status");
}
export async function dashboardStart(port: number, lan: boolean): Promise<DashboardInfo> {
  return invoke<DashboardInfo>("dashboard_start", { port, lan });
}
export async function dashboardStop(): Promise<DashboardInfo> {
  return invoke<DashboardInfo>("dashboard_stop");
}
/** Push the current fleet snapshot JSON for the dashboard to serve. */
export async function dashboardPush(snapshot: string): Promise<void> {
  await invoke("dashboard_push", { snapshot });
}
/** Fire `cb` with the raw JSON body when the dashboard POSTs a send request. */
export async function onDashboardSend(cb: (body: string) => void): Promise<UnlistenFn> {
  return listen<string>("dashboard-send", (e) => cb(e.payload));
}

/* ---- session recording (replay) ---- */

/** Start recording an agent's terminal output to `path` (an absolute JSONL
 *  "cast" file under `<workspace>/.maestro/recordings`). Its parent dir is
 *  created if missing. Replaces any recording already running for the agent. */
export async function recordStart(agentId: string, path: string): Promise<void> {
  await invoke("record_start", { agentId, path });
}

/** Stop recording an agent's output and flush the file. */
export async function recordStop(agentId: string): Promise<void> {
  await invoke("record_stop", { agentId });
}

/** Read a recording file back (JSONL text) for the replay player. */
export async function recordRead(path: string): Promise<string> {
  return invoke<string>("record_read", { path });
}

/* ---- token usage / cost (Claude transcripts) ---- */

export interface ModelUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation: number;
  cache_read: number;
  messages: number;
}

/** Real Claude Code token usage for a workspace folder, summed per model from
 *  its session transcripts (~/.claude/projects/<slug>/*.jsonl). Claude-only and
 *  per-workspace; empty when there are no transcripts. */
export async function claudeUsage(dir: string): Promise<ModelUsage[]> {
  return invoke<ModelUsage[]>("claude_usage", { dir });
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

export interface ChangedFile { path: string; status: string }

/** Files changed vs HEAD (incl. untracked), as {path, status} pairs. */
export async function gitChangedFiles(repoRoot: string): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>("git_changed_files", { repoRoot });
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

/** Open `url` in a temporary webview window, screenshot it natively, save it
 *  under `<root>/.maestro/shots/<name>`, and return the path relative to root.
 *  Used to grab a "done" preview of a web page the agent built. */
export async function captureWebPage(url: string, root: string, name: string): Promise<string> {
  const label = `shot-${Date.now()}`;
  const w = new WebviewWindow(label, {
    url,
    width: 1280,
    height: 860,
    visible: true,
    focus: false,
    skipTaskbar: true,
    title: "Capturing preview…",
  });
  await new Promise<void>((resolve, reject) => {
    void w.once("tauri://created", () => resolve());
    void w.once("tauri://error", (e) => reject(e.payload));
  });
  // Let the page load and paint before the native capture.
  await new Promise((r) => setTimeout(r, 2200));
  try {
    return await invoke<string>("capture_window", { label, root, name });
  } finally {
    await w.close().catch(() => {});
  }
}

/** Create a new empty file (rejects if it already exists). */
export async function fsCreateFile(root: string, path: string): Promise<void> {
  await invoke("fs_create_file", { root, path });
}

/** Create a new directory (rejects if it already exists). */
export async function fsCreateDir(root: string, path: string): Promise<void> {
  await invoke("fs_create_dir", { root, path });
}

/** Rename / move within the workspace root. */
export async function fsRename(root: string, from: string, to: string): Promise<void> {
  await invoke("fs_rename", { root, from, to });
}

/** Delete a file, or a directory and everything under it. */
export async function fsDelete(root: string, path: string): Promise<void> {
  await invoke("fs_delete", { root, path });
}

/** Copy an entry into `toDir` ("" = root), auto-renaming on collision.
 *  Returns the new path relative to the root. */
export async function fsCopy(root: string, from: string, toDir: string): Promise<string> {
  return invoke<string>("fs_copy", { root, from, toDir });
}

/** Move an entry into `toDir` ("" = root), auto-renaming on collision.
 *  Returns the new path relative to the root. */
export async function fsMove(root: string, from: string, toDir: string): Promise<string> {
  return invoke<string>("fs_move", { root, from, toDir });
}

/** Send entries to the Recycle Bin in one operation (recoverable delete). */
export async function fsTrash(root: string, paths: string[]): Promise<void> {
  await invoke("fs_trash", { root, paths });
}

/** Show the entry in the OS file manager, selected. */
export async function fsReveal(root: string, path: string): Promise<void> {
  await invoke("fs_reveal", { root, path });
}

/** Open the entry with the OS default application. */
export async function fsOpenExternal(root: string, path: string): Promise<void> {
  await invoke("fs_open_external", { root, path });
}

/** Directories that changed on disk, coalesced by the backend watcher.
 *  `bulk` means the change set was too large to enumerate — refresh everything. */
export interface FsChange {
  root: string;
  dirs: string[];
  bulk: boolean;
}

/** Start (or re-point) the recursive filesystem watch behind the live tree. */
export async function watchStart(root: string): Promise<void> {
  await invoke("watch_start", { root });
}

/** Stop watching. */
export async function watchStop(): Promise<void> {
  await invoke("watch_stop", {});
}

/** Subscribe to coalesced filesystem changes under the watched root. */
export async function onFsChanged(cb: (c: FsChange) => void): Promise<UnlistenFn> {
  return listen<FsChange>("fs-changed", (e) => cb(e.payload));
}
