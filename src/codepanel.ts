// Pure helpers for the code panel (file tree + editor). No DOM, no Tauri — kept
// here so they can be unit-tested in isolation (like wizard.ts / workspaces.ts).
import type { FsEntry } from "./ipc";

/** Directories hidden from the tree by default (toggle reveals them). */
const HIDDEN_DIRS = new Set(["node_modules", ".git", "target"]);

/** Drop the three heavy build/VCS dirs unless `showHidden`. Dotfiles stay. */
export function filterEntries(entries: FsEntry[], showHidden: boolean): FsEntry[] {
  if (showHidden) return entries;
  return entries.filter((e) => !(e.is_dir && HIDDEN_DIRS.has(e.name)));
}

/** Directories first, then case-insensitive by name. */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) =>
    a.is_dir === b.is_dir
      ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      : a.is_dir
        ? -1
        : 1,
  );
}

const LANG_BY_EXT: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  json: "json",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html",
  md: "markdown", markdown: "markdown",
  rs: "rust", py: "python",
  toml: "toml", yaml: "yaml", yml: "yaml",
  sh: "shell", bash: "shell",
};

/** CodeMirror language key for a filename, or "plaintext" when unknown. */
export function langForFile(name: string): string {
  const i = name.lastIndexOf(".");
  if (i < 0) return "plaintext";
  return LANG_BY_EXT[name.slice(i + 1).toLowerCase()] ?? "plaintext";
}

/** How the editor should react to a disk-vs-buffer state on poll or save. */
export type ConflictAction = "reload" | "banner" | "ok";
export function resolveConflict(diskChanged: boolean, dirty: boolean): ConflictAction {
  if (!diskChanged) return "ok";
  return dirty ? "banner" : "reload";
}
