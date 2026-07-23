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

/** One visible line of the tree: the flattened view the explorer renders. */
export interface TreeRow {
  rel: string;
  name: string;
  isDir: boolean;
  depth: number;
}

/** Flatten the loaded directory cache into the rows currently visible, walking
 *  only into expanded folders. Directories with no cache entry render as a
 *  closed folder (their children load on demand). */
export function flattenTree(
  children: Map<string, FsEntry[]>,
  expanded: Set<string>,
  showHidden: boolean,
): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (dirRel: string, depth: number): void => {
    const kids = children.get(dirRel);
    if (!kids) return;
    for (const e of sortEntries(filterEntries(kids, showHidden))) {
      const rel = dirRel ? `${dirRel}\\${e.name}` : e.name;
      out.push({ rel, name: e.name, isDir: e.is_dir, depth });
      if (e.is_dir && expanded.has(rel)) walk(rel, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

/** How a click/keypress changes the selection: plain, Ctrl (toggle one) or
 *  Shift (extend from the anchor over the visible order) — VS Code's rules. */
export type SelectMode = "set" | "toggle" | "range";

export function applySelection(
  order: string[],
  selected: Set<string>,
  anchor: string | null,
  rel: string,
  mode: SelectMode,
): { selected: Set<string>; anchor: string | null } {
  if (mode === "toggle") {
    const next = new Set(selected);
    if (next.has(rel)) next.delete(rel);
    else next.add(rel);
    return { selected: next, anchor: rel };
  }
  if (mode === "range" && anchor !== null) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(rel);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      // The anchor stays put so dragging the shift-range back and forth works.
      return { selected: new Set(order.slice(lo, hi + 1)), anchor };
    }
  }
  return { selected: new Set([rel]), anchor: rel };
}

/** Parent directory of a workspace-relative path ("" = the root itself). */
export function parentOf(rel: string): string {
  const i = rel.lastIndexOf("\\");
  return i < 0 ? "" : rel.slice(0, i);
}

/** The distinct parent directories of a batch of paths — the set of folders a
 *  bulk delete/move has to reload. */
export function parentsOf(rels: string[]): string[] {
  return [...new Set(rels.map(parentOf))];
}

/** Drop paths already covered by an ancestor in the same batch, so moving a
 *  folder and something inside it doesn't try to move the vanished child. */
export function topLevelOnly(rels: string[]): string[] {
  const set = new Set(rels);
  return rels.filter((r) => {
    for (let p = parentOf(r); p; p = parentOf(p)) if (set.has(p)) return false;
    return true;
  });
}

/** True when `rel` is `dir` itself or lives underneath it. */
export function isInside(rel: string, dir: string): boolean {
  return dir === "" || rel === dir || rel.startsWith(`${dir}\\`);
}

/** Glyph + colour class for a file name, VS Code-style: a handful of shapes
 *  keyed by what the file *is*, tinted per language so the eye can scan. */
const ICON_BY_EXT: Record<string, [string, string]> = {
  ts: ["code", "blue"], tsx: ["code", "blue"], mts: ["code", "blue"], cts: ["code", "blue"],
  js: ["code", "yellow"], jsx: ["code", "yellow"], mjs: ["code", "yellow"], cjs: ["code", "yellow"],
  vue: ["code", "green"], svelte: ["code", "orange"],
  rs: ["gear", "orange"], go: ["code", "cyan"], py: ["code", "blue"], rb: ["code", "red"],
  java: ["code", "red"], kt: ["code", "purple"], c: ["code", "blue"], h: ["code", "blue"],
  cpp: ["code", "blue"], hpp: ["code", "blue"], cs: ["code", "green"], php: ["code", "purple"],
  swift: ["code", "orange"], sql: ["db", "pink"],
  json: ["braces", "yellow"], jsonc: ["braces", "yellow"],
  toml: ["gear", "gray"], yaml: ["gear", "gray"], yml: ["gear", "gray"], ini: ["gear", "gray"],
  env: ["gear", "gray"], lock: ["lock", "gray"],
  css: ["hash", "blue"], scss: ["hash", "pink"], sass: ["hash", "pink"], less: ["hash", "blue"],
  html: ["markup", "orange"], htm: ["markup", "orange"], xml: ["markup", "orange"],
  md: ["doc", "blue"], markdown: ["doc", "blue"], txt: ["doc", "gray"], pdf: ["doc", "red"],
  sh: ["term", "green"], bash: ["term", "green"], zsh: ["term", "green"],
  ps1: ["term", "blue"], bat: ["term", "green"], cmd: ["term", "green"],
  png: ["image", "purple"], jpg: ["image", "purple"], jpeg: ["image", "purple"],
  gif: ["image", "purple"], webp: ["image", "purple"], svg: ["image", "yellow"],
  ico: ["image", "purple"], avif: ["image", "purple"], bmp: ["image", "purple"],
};

/** Dotfiles that deserve their own look even without a useful extension. */
const ICON_BY_NAME: Record<string, [string, string]> = {
  ".gitignore": ["git", "orange"],
  ".gitattributes": ["git", "orange"],
  ".gitmodules": ["git", "orange"],
  "dockerfile": ["gear", "blue"],
  "makefile": ["gear", "gray"],
  "license": ["doc", "yellow"],
  "readme.md": ["doc", "blue"],
};

export function iconForFile(name: string): { glyph: string; color: string } {
  const lower = name.toLowerCase();
  const byName = ICON_BY_NAME[lower];
  if (byName) return { glyph: byName[0], color: byName[1] };
  const i = lower.lastIndexOf(".");
  const ext = i > 0 ? lower.slice(i + 1) : "";
  const hit = ICON_BY_EXT[ext];
  return hit ? { glyph: hit[0], color: hit[1] } : { glyph: "file", color: "gray" };
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

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]);

/** True for files the code panel should preview as an image rather than edit. */
export function isImageFile(name: string): boolean {
  const i = name.lastIndexOf(".");
  return i >= 0 && IMAGE_EXT.has(name.slice(i + 1).toLowerCase());
}
