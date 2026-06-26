# Maestro — Folder Sidebar + Code Panel (read & edit)

**Date:** 2026-06-26
**Status:** Approved design, pending implementation plan

## Problem

Maestro organizes work as a horizontal strip of **workspace tabs** in the topbar.
Each workspace already maps to a folder + a grid of terminal panes (AI agent CLIs).
Two pain points:

1. The horizontal tab strip does not scale when many repos/folders are open — it is
   hard to manage at a glance.
2. To read or edit the code an agent is producing, the user must open a separate,
   heavyweight editor (VS Code etc.) outside Maestro.

## Goals

- Replace the horizontal workspace **tab strip** with a vertical **project rail** on
  the left ("organize by folder").
- Add a right-side **code panel**: a lazy file-tree of the active workspace's folder
  plus a **lightweight editor** to read and edit files in place, with save-to-disk.
- Keep existing strengths: detach/merge workspace into its own window, per-agent
  worktree isolation, broadcast bar, dock rail.

## Non-goals (YAGNI)

- No full IDE (no IntelliSense, no multi-file tabs in the editor, no Monaco).
- No LSP, no project-wide search/replace, no git operations from the tree (the dock
  already has a diff viewer).
- No file create/delete/rename from the tree in v1 (edit existing files only). May be
  added later.

## Decisions (from brainstorming)

- **Navigation model:** left vertical **project list** (replaces tabs) · center
  terminals · right **file-tree + editor**.
- **Editor depth:** lightweight — **CodeMirror 6** (tree-shakeable), view + edit +
  save. Not read-only, not Monaco.
- **Detach window:** keep the existing detach/merge feature, triggered from the left
  rail instead of the tab strip.
- **Save behavior:** `Ctrl+S` writes to disk; detect external modification (agent/CLI
  touched the file) via `mtime` and warn before overwriting.
- **File-tree defaults:** hide `node_modules`, `.git`, `target` by default (toggle to
  show).

## Architecture

### Layout (`index.html`, `src/styles/workspace.css`)

`.app` grid changes from 2 columns (`1fr 48px`) to four regions:

```
grid-template-columns: var(--rail-w, 220px) 1fr var(--code-w, 380px) 48px;
grid-template-rows:    46px 1fr auto;   /* topbar / main / broadcast (unchanged) */
```

- Region 1 — **project rail** (left, ~220px, resizable, collapsible).
- Region 2 — **terminals** grid (center, `1fr`, unchanged internals).
- Region 3 — **code panel** (right, ~380px, resizable, collapsible).
- Region 4 — **dock rail** (48px icon rail, unchanged).

Topbar: the horizontal `.tabstrip` is removed; action buttons + stats remain.
Broadcast bar spans the bottom as today.

Splitters between rail/center and center/code are **resizable via Pointer Events**
(not HTML5 drag — WebView2 breaks HTML5 DnD; see project memory). Column widths and
collapsed/expanded state persist in `localStorage`.

### Left project rail — `src/sidebar.ts` (+ `src/styles/sidebar.css`)

Reuses the existing `Workspace` data model unchanged; only the rendering moves from a
horizontal tab to a vertical list item. Each item shows: status dot, project name
(`basename(dir)`), live pane count, close button.

Behaviors (port existing tab logic, swap HTML5 DnD for Pointer Events):
- Click → `activateWorkspace`.
- Double-click → inline rename (`startTabRename` logic).
- Drag within rail → reorder (persist order, reuse `commitTabOrder`).
- Drag out of window → **detach** to a new Maestro window (reuse existing detach/merge
  logic in `main.ts`).

### Right code panel — file tree + editor

**File tree — `src/filetree.ts` (+ `src/styles/filetree.css`)**

- Root = `activeWs.dir`. If the workspace has no dir (`null`), show an empty state.
- **Lazy**: a directory's children are fetched (`fs_read_dir`) only when expanded.
- Entries sorted directories-first, then alphabetical (case-insensitive).
- Default-hidden names: `node_modules`, `.git`, `target` (and dotfiles? — show
  dotfiles, hide only the three heavy dirs). A toggle reveals hidden entries.
- Rendering and any drag interactions use Pointer Events.
- Selecting a file → load it into the editor.
- Switching the active workspace re-roots the tree to the new workspace's dir.

**Editor — `src/editor.ts` (+ `src/styles/editor.css`)**

- **CodeMirror 6** mounted in the lower part of the code panel.
- Language/syntax highlight chosen by file extension (a small extension→language map;
  cover common: js/ts/tsx/jsx, json, css/scss, html, md, rs, py, toml, yaml, sh).
  Unknown extensions load with no language (plain text).
- Dirty indicator (dot) when the buffer differs from the on-disk version.
- `Ctrl+S` → `fs_write_file(root, path, content, expectedMtime)`.
- **External-change detection:** while a file is open, poll `fs_stat` (on window focus
  and on an interval, e.g. every 3s). Cases:
  - disk mtime changed AND editor not dirty → silently reload buffer.
  - disk mtime changed AND editor dirty → show a banner "File changed on disk" with
    **Reload** (discard edits) / **Keep mine** (dismiss; next save will conflict).
  - On `Ctrl+S`, if backend returns `Conflict` (mtime mismatch) → show the same banner
    with **Overwrite** (re-save ignoring mtime) / **Reload**.
- Large/binary files: the backend refuses (see below); the editor shows a "can't open
  this file" placeholder.

### Backend — filesystem commands (`src-tauri/src/core/fs.rs`, registered in `lib.rs`)

The backend currently exposes PTY + git + folder-picker only; no general file I/O.
Add four commands. Every command takes a `root` (the workspace dir) and the target
`path`; both are canonicalized and the target **must** resolve inside `root` or the
command returns an error (path-traversal / symlink-escape guard).

- `fs_read_dir(root, path) -> Vec<Entry>` where `Entry { name, is_dir, size }`,
  one level only, dirs-first sort done on the frontend or backend (backend preferred).
- `fs_read_file(root, path) -> FileData { content, mtime }`. Refuse if size > ~2 MB or
  content looks binary (NUL byte in the first chunk) → typed error the UI can show.
- `fs_write_file(root, path, content, expected_mtime: Option<...>) -> WriteResult { mtime }`.
  If `expected_mtime` is `Some` and the current on-disk mtime differs → return a
  `Conflict` error carrying the current mtime. Otherwise write and return the new mtime.
- `fs_stat(root, path) -> Stat { mtime }` for external-change polling.

`mtime` is serialized as a stable integer (e.g. milliseconds since epoch) so the
frontend can compare cheaply.

Frontend wrappers go in `src/ipc.ts` alongside the existing typed command wrappers.

## Data flow

1. User picks a folder (existing wizard) → workspace gets `dir`.
2. Left rail lists the workspace; activating it shows its terminals (center) and
   re-roots the file tree (right) to `dir`.
3. User clicks a file → `fs_read_file` → CodeMirror buffer + stored `mtime`.
4. User edits → dirty dot. `Ctrl+S` → `fs_write_file(..., expectedMtime)`.
5. Background poll `fs_stat`; agent edits to the same file surface as a reload/conflict
   banner instead of a silent lost update.

## Error handling

- Path outside `root`, missing file, permission denied, binary/too-large → typed
  errors surfaced as inline UI states (tree row error / editor placeholder / save
  banner). No crashes, no silent failure.
- Workspace with `dir == null` → code panel shows "No folder for this workspace".
- Save conflict → never overwrite silently; always require an explicit user choice.

## Testing

- **TS (vitest), pure helpers:**
  - file-tree sort + hidden-name filtering.
  - extension → CodeMirror language mapping.
  - mtime conflict decision (dirty × changed matrix → reload / banner / conflict).
- **Rust:**
  - path-scoping: reject `..` escape, absolute path outside root, symlink pointing
    outside root; accept legitimate nested paths.
  - binary/oversize refusal.

## New dependencies

- CodeMirror 6: `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`,
  `@codemirror/language`, and a minimal set of `@codemirror/lang-*` for the common
  languages above. Added to `package.json`. Chosen for being lightweight and
  tree-shakeable (vs. Monaco), matching the "light editor" requirement.

## Affected / new files

- New: `src/sidebar.ts`, `src/filetree.ts`, `src/editor.ts` and matching
  `src/styles/sidebar.css`, `src/styles/filetree.css`, `src/styles/editor.css`.
- New: `src-tauri/src/core/fs.rs`.
- Edited: `index.html` (remove tabstrip, add rail + code panel containers),
  `src/styles/workspace.css` (4-column grid + splitters), `src/main.ts` (wire rail to
  workspace lifecycle, mount tree/editor, re-root on activate), `src/ipc.ts` (fs
  wrappers), `src-tauri/src/lib.rs` (register fs commands), `package.json` (CodeMirror).

## Design alignment

Follows the global frontend standards (restraint, clear hierarchy, intentional
spacing) and the project's modular-CSS-per-feature convention. The visual treatment of
the rail and code panel will be handled with the design skills during implementation
(`design-taste-frontend` / `frontend-design`).
