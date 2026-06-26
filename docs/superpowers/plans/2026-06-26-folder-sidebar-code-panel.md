# Folder Sidebar + Code Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Maestro's horizontal workspace tab strip with a vertical left project rail, and add a right-side code panel (lazy file tree + lightweight CodeMirror editor) to read and edit files in place.

**Architecture:** Add general-purpose filesystem commands to the Rust backend (path-scoped to each workspace's folder). On the frontend, reshape `.app` from a 2-column grid to a 4-column grid (project rail · terminals · code panel · dock rail). Reuse the existing, already-shipping HTML5-drag tab logic for the rail (axis flipped to vertical); use pointer-drag only for the new resize splitters. The file tree and editor are new vanilla-TS modules consuming the backend commands; pure logic lives in a separate tested helper module.

**Tech Stack:** Tauri 2, Rust (std::fs), vanilla TypeScript (no framework), CodeMirror 6, xterm.js (existing), Vite, Vitest (happy-dom), `cargo test`.

## Global Constraints

- Platform: Windows-only desktop app (Tauri 2). Paths are Windows paths.
- Frontend is vanilla TS — **no framework**. One CSS file per feature, imported in `src/styles/index.css`.
- **Drag:** reuse the existing HTML5-drag implementation for the project rail (it already ships for tabs in v0.2.0). Do **not** introduce new HTML5 drag for the file tree (v1 tree has no drag). Resize splitters use pointer events (`pointerdown`/`pointermove`/`pointerup` + `setPointerCapture`), which is not drag-and-drop.
- All filesystem commands take a `root` (the workspace folder) and a `path`; the resolved target **must** stay inside `root` (path-traversal guard). `mtime` is an `i64` of milliseconds since the Unix epoch on both sides.
- v1 edits **existing files only** — no create/delete/rename from the tree.
- File open is refused for files `> 2 MiB` or binary (NUL byte in first 8000 bytes).
- Editor: CodeMirror 6. Save with `Ctrl+S`. Never overwrite silently on an mtime conflict.
- Tests: TS pure logic in colocated `*.test.ts` (Vitest, happy-dom already configured); Rust in `#[cfg(test)] mod tests` using `tempfile` (already a dev-dependency).
- Existing typed-command pattern: frontend wrappers in `src/ipc.ts` call `invoke("snake_case_cmd", {...camelCaseArgs})`; Rust commands return `Result<T, CommandError>` and are registered in `src-tauri/src/lib.rs`'s `invoke_handler!`.

---

### Task 1: Backend — path scoping + `fs_read_dir`

**Files:**
- Create: `src-tauri/src/core/fs.rs`
- Modify: `src-tauri/src/core/mod.rs` (add `pub mod fs;`)
- Modify: `src-tauri/src/lib.rs:76-96` (register `core::fs::fs_read_dir` in `invoke_handler!`)

**Interfaces:**
- Produces (Rust): `pub fn fs_read_dir(root: String, path: String) -> Result<Vec<Entry>, CommandError>`; `pub struct Entry { name: String, is_dir: bool, size: u64 }` (serde `Serialize`); internal `fn scoped(root: &str, path: &str) -> Result<PathBuf, CommandError>` and `fn mtime_ms(meta: &std::fs::Metadata) -> i64`.

- [ ] **Step 1: Create `fs.rs` with the scoping helper, shared types, and `fs_read_dir`**

```rust
// src-tauri/src/core/fs.rs
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::CommandError;

/// Refuse to open files larger than this (binary blobs, build artifacts, etc.).
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize)]
pub struct FileData {
    pub content: String,
    pub mtime: i64,
}

#[derive(Serialize)]
pub struct Stat {
    pub mtime: i64,
}

#[derive(Serialize)]
pub struct WriteResult {
    pub mtime: i64,
}

/// Modified-time in milliseconds since the Unix epoch (0 when unavailable).
pub fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Canonicalize `path` (absolute, or relative to `root`) and verify it stays
/// inside the canonical `root`. Rejects `..` escapes, absolute paths outside
/// the workspace, and symlinks that resolve outside. The target must exist.
pub fn scoped(root: &str, path: &str) -> Result<PathBuf, CommandError> {
    let root_c = std::fs::canonicalize(root)
        .map_err(|e| CommandError::Failed(format!("bad root: {e}")))?;
    let target = Path::new(path);
    let joined: PathBuf = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root_c.join(target)
    };
    let canon = std::fs::canonicalize(&joined)
        .map_err(|e| CommandError::Failed(format!("no such path: {e}")))?;
    if !canon.starts_with(&root_c) {
        return Err(CommandError::Failed("path escapes workspace root".into()));
    }
    Ok(canon)
}

/// List one directory level. Directories first, then case-insensitive by name.
#[tauri::command]
pub fn fs_read_dir(root: String, path: String) -> Result<Vec<Entry>, CommandError> {
    let dir = scoped(&root, &path)?;
    let mut out = Vec::new();
    for ent in std::fs::read_dir(&dir).map_err(|e| CommandError::Failed(e.to_string()))? {
        let ent = ent.map_err(|e| CommandError::Failed(e.to_string()))?;
        let meta = ent
            .metadata()
            .map_err(|e| CommandError::Failed(e.to_string()))?;
        out.push(Entry {
            name: ent.file_name().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_rejects_parent_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        // A sibling outside root.
        let outside = tmp.path().parent().unwrap().join("outside.txt");
        std::fs::write(&outside, "x").unwrap();
        let rel = format!("..\\{}", outside.file_name().unwrap().to_string_lossy());
        assert!(scoped(&root, &rel).is_err());
    }

    #[test]
    fn scoped_accepts_nested_child() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("sub")).unwrap();
        std::fs::write(tmp.path().join("sub").join("a.txt"), "hi").unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        assert!(scoped(&root, "sub\\a.txt").is_ok());
    }

    #[test]
    fn read_dir_lists_dirs_first_sorted() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("b.txt"), "x").unwrap();
        std::fs::write(tmp.path().join("A.txt"), "x").unwrap();
        std::fs::create_dir(tmp.path().join("zdir")).unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let got = fs_read_dir(root, ".".into()).unwrap();
        let names: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["zdir", "A.txt", "b.txt"]);
        assert!(got[0].is_dir);
    }
}
```

- [ ] **Step 2: Wire the module + command into the crate**

In `src-tauri/src/core/mod.rs`, add the line (keep alongside existing `pub mod` lines):

```rust
pub mod fs;
```

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![ ... ]` (currently ending at line 95), add after the `review::*` entries:

```rust
            core::fs::fs_read_dir,
```

- [ ] **Step 3: Run the Rust tests — expect PASS**

Run: `cd src-tauri && cargo test fs::`
Expected: `scoped_rejects_parent_escape`, `scoped_accepts_nested_child`, `read_dir_lists_dirs_first_sorted` all pass.

- [ ] **Step 4: Typecheck the whole crate compiles**

Run: `cd src-tauri && cargo build`
Expected: builds with no errors (the new command is referenced by `invoke_handler!`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/core/fs.rs src-tauri/src/core/mod.rs src-tauri/src/lib.rs
git commit -m "feat(fs): scoped fs_read_dir backend command"
```

---

### Task 2: Backend — `fs_read_file` + `fs_stat`

**Files:**
- Modify: `src-tauri/src/core/fs.rs` (add two commands + tests)
- Modify: `src-tauri/src/lib.rs` (register both)

**Interfaces:**
- Consumes: `scoped`, `mtime_ms`, `FileData`, `Stat`, `MAX_FILE_BYTES` from Task 1.
- Produces: `pub fn fs_read_file(root: String, path: String) -> Result<FileData, CommandError>`; `pub fn fs_stat(root: String, path: String) -> Result<Stat, CommandError>`.

- [ ] **Step 1: Add the two commands to `fs.rs`** (place above the `#[cfg(test)] mod tests` block)

```rust
/// Read a UTF-8 (lossy) text file. Refuses oversize or binary files.
#[tauri::command]
pub fn fs_read_file(root: String, path: String) -> Result<FileData, CommandError> {
    let file = scoped(&root, &path)?;
    let meta = std::fs::metadata(&file).map_err(|e| CommandError::Failed(e.to_string()))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(CommandError::Failed("file too large to open (>2 MB)".into()));
    }
    let bytes = std::fs::read(&file).map_err(|e| CommandError::Failed(e.to_string()))?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err(CommandError::Failed("binary file".into()));
    }
    Ok(FileData {
        content: String::from_utf8_lossy(&bytes).to_string(),
        mtime: mtime_ms(&meta),
    })
}

/// Cheap modified-time probe for external-change detection.
#[tauri::command]
pub fn fs_stat(root: String, path: String) -> Result<Stat, CommandError> {
    let file = scoped(&root, &path)?;
    let meta = std::fs::metadata(&file).map_err(|e| CommandError::Failed(e.to_string()))?;
    Ok(Stat {
        mtime: mtime_ms(&meta),
    })
}
```

- [ ] **Step 2: Add tests inside the existing `mod tests`**

```rust
    #[test]
    fn read_file_returns_content_and_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let f = fs_read_file(root, "a.txt".into()).unwrap();
        assert_eq!(f.content, "hello");
        assert!(f.mtime > 0);
    }

    #[test]
    fn read_file_rejects_binary() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("b.bin"), [0u8, 1, 2, 3]).unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        assert!(fs_read_file(root, "b.bin".into()).is_err());
    }
```

- [ ] **Step 3: Register both commands in `lib.rs`** (after `core::fs::fs_read_dir`)

```rust
            core::fs::fs_read_file,
            core::fs::fs_stat,
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd src-tauri && cargo test fs::`
Expected: the two new tests pass alongside Task 1's.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/core/fs.rs src-tauri/src/lib.rs
git commit -m "feat(fs): fs_read_file + fs_stat with binary/oversize guards"
```

---

### Task 3: Backend — `fs_write_file` with mtime conflict

**Files:**
- Modify: `src-tauri/src/error.rs` (add `Conflict(i64)` variant)
- Modify: `src-tauri/src/core/fs.rs` (add command + tests)
- Modify: `src-tauri/src/lib.rs` (register)

**Interfaces:**
- Consumes: `scoped`, `mtime_ms`, `WriteResult`.
- Produces: `pub fn fs_write_file(root: String, path: String, content: String, expected_mtime: Option<i64>) -> Result<WriteResult, CommandError>`. On stale mtime it returns `CommandError::Conflict(current_mtime)`, which serializes to `{"Conflict":<i64>}`.

- [ ] **Step 1: Add the `Conflict` variant to `error.rs`** (replace the enum body; keep the existing `From<anyhow::Error>` impl and the existing test unchanged)

```rust
#[derive(Debug, thiserror::Error, Serialize)]
pub enum CommandError {
    #[error("{0}")]
    Failed(String),
    /// A write was rejected because the file changed on disk since it was read.
    /// Carries the current on-disk mtime (ms) so the UI can offer reload/overwrite.
    #[error("file changed on disk")]
    Conflict(i64),
}
```

- [ ] **Step 2: Add `fs_write_file` to `fs.rs`** (above `#[cfg(test)]`)

```rust
/// Write a text file. When `expected_mtime` is provided and the on-disk mtime
/// differs, the write is refused with `Conflict(current_mtime)` so the caller
/// never silently clobbers an external (agent) edit. Returns the new mtime.
#[tauri::command]
pub fn fs_write_file(
    root: String,
    path: String,
    content: String,
    expected_mtime: Option<i64>,
) -> Result<WriteResult, CommandError> {
    let file = scoped(&root, &path)?;
    if let Some(expected) = expected_mtime {
        let meta = std::fs::metadata(&file).map_err(|e| CommandError::Failed(e.to_string()))?;
        let current = mtime_ms(&meta);
        if current != expected {
            return Err(CommandError::Conflict(current));
        }
    }
    std::fs::write(&file, content.as_bytes()).map_err(|e| CommandError::Failed(e.to_string()))?;
    let meta = std::fs::metadata(&file).map_err(|e| CommandError::Failed(e.to_string()))?;
    Ok(WriteResult {
        mtime: mtime_ms(&meta),
    })
}
```

- [ ] **Step 3: Add tests inside `mod tests`**

```rust
    #[test]
    fn write_file_persists_and_returns_new_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "old").unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let r = fs_write_file(root.clone(), "a.txt".into(), "new".into(), None).unwrap();
        assert!(r.mtime > 0);
        assert_eq!(std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(), "new");
    }

    #[test]
    fn write_file_conflicts_on_stale_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "old").unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        // Pretend we read it at mtime 1 (definitely stale vs. the real file).
        let err = fs_write_file(root, "a.txt".into(), "new".into(), Some(1)).unwrap_err();
        match err {
            CommandError::Conflict(_) => {}
            other => panic!("expected Conflict, got {other:?}"),
        }
        // File must be untouched.
        assert_eq!(std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(), "old");
    }
```

- [ ] **Step 4: Register in `lib.rs`** (after `core::fs::fs_stat`)

```rust
            core::fs::fs_write_file,
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `cd src-tauri && cargo test`
Expected: all `fs::` tests pass, plus the existing `error::tests::serializes_to_stable_shape` still passes.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/error.rs src-tauri/src/core/fs.rs src-tauri/src/lib.rs
git commit -m "feat(fs): fs_write_file with mtime conflict guard"
```

---

### Task 4: Frontend — IPC wrappers + pure code-panel helpers

**Files:**
- Modify: `src/ipc.ts` (add `FsEntry` type + four wrappers at end of file)
- Create: `src/codepanel.ts`
- Create (test): `src/codepanel.test.ts`

**Interfaces:**
- Produces (ipc): `interface FsEntry { name: string; is_dir: boolean; size: number }`; `fsReadDir(root, path): Promise<FsEntry[]>`; `fsReadFile(root, path): Promise<{content:string; mtime:number}>`; `fsStat(root, path): Promise<{mtime:number}>`; `fsWriteFile(root, path, content, expectedMtime: number|null): Promise<{mtime:number}>`.
- Produces (codepanel): `filterEntries(entries, showHidden): FsEntry[]`; `sortEntries(entries): FsEntry[]`; `langForFile(name): string`; `resolveConflict(diskChanged, dirty): "reload"|"banner"|"ok"`.

- [ ] **Step 1: Add the IPC wrappers at the end of `src/ipc.ts`**

```ts
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
```

- [ ] **Step 2: Write the failing test `src/codepanel.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { filterEntries, sortEntries, langForFile, resolveConflict } from "./codepanel";
import type { FsEntry } from "./ipc";

const dir = (name: string): FsEntry => ({ name, is_dir: true, size: 0 });
const file = (name: string): FsEntry => ({ name, is_dir: false, size: 1 });

describe("filterEntries", () => {
  it("hides heavy dirs by default but keeps dotfiles", () => {
    const got = filterEntries([dir("node_modules"), dir(".git"), dir("src"), file(".env")], false);
    expect(got.map((e) => e.name)).toEqual(["src", ".env"]);
  });
  it("shows everything when showHidden is true", () => {
    const got = filterEntries([dir("node_modules"), dir("src")], true);
    expect(got.map((e) => e.name)).toEqual(["node_modules", "src"]);
  });
});

describe("sortEntries", () => {
  it("orders directories first, then case-insensitive by name", () => {
    const got = sortEntries([file("b.ts"), file("A.ts"), dir("zdir")]);
    expect(got.map((e) => e.name)).toEqual(["zdir", "A.ts", "b.ts"]);
  });
});

describe("langForFile", () => {
  it("maps known extensions and falls back to plaintext", () => {
    expect(langForFile("main.ts")).toBe("typescript");
    expect(langForFile("a.rs")).toBe("rust");
    expect(langForFile("README")).toBe("plaintext");
    expect(langForFile("weird.xyz")).toBe("plaintext");
  });
});

describe("resolveConflict", () => {
  it("returns ok when disk did not change", () => {
    expect(resolveConflict(false, true)).toBe("ok");
  });
  it("reloads when disk changed and buffer is clean", () => {
    expect(resolveConflict(true, false)).toBe("reload");
  });
  it("warns (banner) when disk changed and buffer is dirty", () => {
    expect(resolveConflict(true, true)).toBe("banner");
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run src/codepanel.test.ts`
Expected: FAIL — `Cannot find module './codepanel'`.

- [ ] **Step 4: Implement `src/codepanel.ts`**

```ts
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
```

- [ ] **Step 5: Run the test — expect PASS**

Run: `npx vitest run src/codepanel.test.ts`
Expected: all 8 assertions pass.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/ipc.ts src/codepanel.ts src/codepanel.test.ts
git commit -m "feat(codepanel): fs IPC wrappers + tested pure helpers"
```

---

### Task 5: Frontend — 4-column layout shell + resize splitters

**Files:**
- Modify: `index.html:106-146` (add left rail container + right code-panel container with two splitter handles)
- Modify: `src/styles/workspace.css:4-8` (change `.app` grid to 4 columns + region placement)
- Create: `src/styles/panels.css` (rail/code-panel shells + splitter styling)
- Modify: `src/styles/index.css` (add `@import "./panels.css";`)
- Create: `src/panels.ts` (splitter wiring + width persistence; exports a tested pure `clampWidth`)
- Create (test): `src/panels.test.ts`
- Modify: `src/main.ts` (call `initPanels()` during startup)

**Interfaces:**
- Produces: `clampWidth(px: number, min: number, max: number): number`; `initPanels(): void` (wires both splitters, restores persisted widths). Persists to `localStorage` keys `maestro.railW` / `maestro.codeW`.
- DOM contract for later tasks: `#projectRail` (left, empty for now), `#codePanel` containing `#fileTree` and `#editorHost`.

- [ ] **Step 1: Add containers to `index.html`** — inside `<div class="app" id="app" hidden>`, place the rail right after the `</header>` (before `<main class="main">`), and the code panel right after `</main>` (before the `<nav class="dock-rail">`):

```html
  <aside class="project-rail" id="projectRail">
    <div class="rail-split" id="railSplit" title="Drag to resize"></div>
  </aside>
```

and

```html
  <aside class="code-panel" id="codePanel">
    <div class="code-split" id="codeSplit" title="Drag to resize"></div>
    <div class="file-tree" id="fileTree"></div>
    <div class="editor-host" id="editorHost"></div>
  </aside>
```

(Keep the existing `<nav class="tabstrip">` in the topbar for now — Task 6 removes it.)

- [ ] **Step 2: Change the `.app` grid in `src/styles/workspace.css`** — replace lines 4–8 with:

```css
.app{position:relative;display:grid;grid-template-columns:var(--rail-w,216px) 1fr var(--code-w,380px) 48px;grid-template-rows:46px 1fr auto;height:100vh;width:100vw}
.app > .topbar{grid-column:1 / -1}
.app > .project-rail{grid-column:1;grid-row:2}
.app > .main{grid-column:2;grid-row:2}
.app > .code-panel{grid-column:3;grid-row:2}
.app > .dock-rail{grid-column:4;grid-row:2}
.app > .bcast{grid-column:1 / -1}
.app.rail-hidden{--rail-w:0px}
.app.code-hidden{--code-w:0px}
```

- [ ] **Step 3: Create `src/styles/panels.css`**

```css
/* Left project rail + right code panel shells, and their resize splitters.
   The grid columns are driven by --rail-w / --code-w on .app (workspace.css). */
.project-rail{position:relative;background:#0e1218;border-right:1px solid var(--line);overflow:hidden;display:flex;flex-direction:column;min-width:0}
.code-panel{position:relative;background:#0b0f14;border-left:1px solid var(--line);overflow:hidden;display:flex;flex-direction:column;min-width:0}
.rail-hidden .project-rail,.code-hidden .code-panel{border:0}

/* 5px hit-area splitters straddling the column borders. */
.rail-split{position:absolute;top:0;right:-2px;width:5px;height:100%;cursor:col-resize;z-index:8}
.code-split{position:absolute;top:0;left:-2px;width:5px;height:100%;cursor:col-resize;z-index:8}
.rail-split:hover,.code-split:hover,.splitting .rail-split,.splitting .code-split{background:var(--accent-dim)}

.code-panel .file-tree{flex:0 0 45%;min-height:0;overflow:auto;border-bottom:1px solid var(--line)}
.code-panel .editor-host{flex:1;min-height:0;overflow:hidden;position:relative}
body.splitting{cursor:col-resize;user-select:none}
```

- [ ] **Step 4: Register the stylesheet** — add to `src/styles/index.css` after the `workspace.css` import:

```css
@import "./panels.css";
```

- [ ] **Step 5: Write the failing test `src/panels.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { clampWidth } from "./panels";

describe("clampWidth", () => {
  it("clamps below min and above max, passes through in range", () => {
    expect(clampWidth(10, 120, 600)).toBe(120);
    expect(clampWidth(900, 120, 600)).toBe(600);
    expect(clampWidth(300, 120, 600)).toBe(300);
  });
});
```

- [ ] **Step 6: Run it — expect FAIL**

Run: `npx vitest run src/panels.test.ts`
Expected: FAIL — `Cannot find module './panels'`.

- [ ] **Step 7: Implement `src/panels.ts`**

```ts
// Resize splitters for the project rail (left) and code panel (right), plus
// persistence of their widths. Uses pointer events (setPointerCapture) — NOT
// HTML5 drag — so dragging never interacts with the OS file-drop machinery.

const RAIL = { key: "maestro.railW", varName: "--rail-w", min: 150, max: 480, def: 216 };
const CODE = { key: "maestro.codeW", varName: "--code-w", min: 240, max: 760, def: 380 };

/** Clamp a pixel width into [min, max]. */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, px));
}

function restore(app: HTMLElement, cfg: typeof RAIL): void {
  const saved = Number(localStorage.getItem(cfg.key));
  const w = clampWidth(Number.isFinite(saved) && saved > 0 ? saved : cfg.def, cfg.min, cfg.max);
  app.style.setProperty(cfg.varName, `${w}px`);
}

function wireSplitter(
  app: HTMLElement,
  handle: HTMLElement,
  cfg: typeof RAIL,
  edge: "left" | "right",
): void {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("splitting");
    const rect = app.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      // Left rail grows with cursor X; right panel grows as cursor moves left.
      const raw = edge === "left" ? ev.clientX - rect.left : rect.right - ev.clientX;
      app.style.setProperty(cfg.varName, `${clampWidth(raw, cfg.min, cfg.max)}px`);
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(e.pointerId);
      document.body.classList.remove("splitting");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      const cur = app.style.getPropertyValue(cfg.varName).replace("px", "").trim();
      localStorage.setItem(cfg.key, cur);
      void ev;
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

/** Restore persisted widths and make both splitters draggable. */
export function initPanels(): void {
  const app = document.getElementById("app");
  const railSplit = document.getElementById("railSplit");
  const codeSplit = document.getElementById("codeSplit");
  if (!app || !railSplit || !codeSplit) return;
  restore(app, RAIL);
  restore(app, CODE);
  wireSplitter(app, railSplit, RAIL, "left");
  wireSplitter(app, codeSplit, CODE, "right");
}
```

- [ ] **Step 8: Run the test — expect PASS**

Run: `npx vitest run src/panels.test.ts`
Expected: PASS.

- [ ] **Step 9: Call `initPanels()` during startup** — in `src/main.ts`, add the import near the other local imports (after `import { Mascot } from "./mascot";` at line 53):

```ts
import { initPanels } from "./panels";
```

Then find the startup/init block (where other one-time setup like `initDock(...)` / `initTitlebar()` runs) and add, alongside those calls:

```ts
  initPanels();
```

- [ ] **Step 10: Typecheck + visually verify**

Run: `npx tsc --noEmit` (expect no errors), then `npm run tauri dev`.
Expected: the workspace view now shows an empty left rail and an empty right code panel; dragging either splitter resizes the column and the width persists across reload. Tabs still work in the topbar.

- [ ] **Step 11: Commit**

```bash
git add index.html src/styles/workspace.css src/styles/panels.css src/styles/index.css src/panels.ts src/panels.test.ts src/main.ts
git commit -m "feat(panels): 4-column layout shell with resize splitters"
```

---

### Task 6: Frontend — project rail replaces the tab strip

**Files:**
- Modify: `index.html` (remove the `<nav class="tabstrip">` block from the topbar; add a "+ Project" button into `#projectRail`)
- Create: `src/styles/sidebar.css`
- Modify: `src/styles/index.css` (add `@import "./sidebar.css";`)
- Modify: `src/main.ts` (repoint `tabstrip`/`tabAdd` refs to the rail; build rail items; flip drag axis to vertical; update `commitTabOrder` query)

**Interfaces:**
- Consumes: existing `Workspace` interface (its `tabEl` field now holds a `.proj` rail item), `activateWorkspace`, `startTabRename`, `removeWorkspace`, `detachWorkspace`, `mergeWorkspaceToMain`, `wireTabDrag`, `commitTabOrder`, `saveSession`, `openModal`, `KILL_SVG`.
- Produces: rail DOM under `#projectRail`; no change to the `Workspace` type or to other modules.

- [ ] **Step 1: Edit `index.html` topbar** — delete the `<nav class="tabstrip" id="tabstrip"> ... </nav>` block (lines ~109–111, including the inner `#tabAdd` button). The `tb-home` button and the `spacer` remain.

- [ ] **Step 2: Add a rail header with the add button** — inside `#projectRail` in `index.html`, before the `#railSplit` div, add:

```html
    <div class="rail-head">
      <span class="rail-title">Projects</span>
      <button class="rail-add" id="railAdd" aria-label="New project" title="New project">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
    <div class="rail-list" id="railList"></div>
```

- [ ] **Step 3: Create `src/styles/sidebar.css`**

```css
/* Vertical project rail (replaces the old horizontal tab strip). One row per
   workspace = one folder. Mirrors .tab states (live/attn/active) vertically. */
.rail-head{display:flex;align-items:center;justify-content:space-between;height:38px;padding:0 8px 0 12px;border-bottom:1px solid var(--line);flex:none}
.rail-title{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-2)}
.rail-add{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;color:var(--muted)}
.rail-add:hover{background:var(--surface-1);color:var(--accent)}
.rail-list{flex:1;min-height:0;overflow-y:auto;padding:6px}

.proj{display:flex;align-items:center;gap:8px;height:34px;padding:0 6px 0 10px;border-radius:8px;color:var(--muted);cursor:pointer;transition:background .14s,color .14s}
.proj:hover{background:var(--surface-1);color:var(--text-2)}
.proj.active{background:var(--surface-2);color:var(--text)}
.proj .tdot{width:6px;height:6px;border-radius:50%;background:var(--idle);flex:none}
.proj.live .tdot{background:var(--run);box-shadow:0 0 6px var(--run)}
.proj.attn .tdot{background:#ffb84c;box-shadow:0 0 6px #ffb84c}
.proj .tname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:500}
.proj .tcount{font-family:var(--mono);font-size:10px;font-variant-numeric:tabular-nums;color:var(--muted-2);background:var(--surface-3);border-radius:4px;padding:1px 5px;flex:none}
.proj.active .tcount{color:var(--text-2)}
.proj .tclose{width:18px;height:18px;border-radius:5px;display:grid;place-items:center;color:var(--muted-2);flex:none}
.proj .tclose:hover{background:var(--surface-3);color:var(--err)}
.proj.dragging{opacity:.4}
.rail-list.reordering .proj{transition:none}
.tname-edit{background:var(--surface-3);border:1px solid var(--line-strong);color:var(--text);border-radius:5px;font:inherit;font-size:12px;padding:1px 6px;width:100%;outline:none}
.tname-edit:focus{border-color:var(--accent-dim)}
```

- [ ] **Step 4: Register the stylesheet** — add to `src/styles/index.css` after `panels.css`:

```css
@import "./sidebar.css";
```

- [ ] **Step 5: Repoint the DOM refs in `src/main.ts`** — replace the two lines at `src/main.ts:131-132`:

```ts
const tabstrip = document.getElementById("tabstrip") as HTMLElement;
const tabAdd = document.getElementById("tabAdd") as HTMLElement;
```

with:

```ts
// The project rail replaces the old horizontal tab strip. `railList` holds the
// `.proj` rows; the old `tabstrip`/`tabAdd` names are kept as aliases so the
// rest of the workspace logic (drag, order, rename) stays untouched.
const railList = document.getElementById("railList") as HTMLElement;
const railAdd = document.getElementById("railAdd") as HTMLElement;
const tabstrip = railList;
const tabAdd = railAdd;
```

(Then wherever the old code did `tabstrip.insertBefore(tabEl, tabAdd)` — see next step — the add button lives in the rail header, not in the list, so insert at the end of `railList` instead.)

- [ ] **Step 6: Build a rail item instead of a tab** — in `createWorkspace` (`src/main.ts:185-192`), replace:

```ts
  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.innerHTML =
    `<span class="tdot"></span><span class="tname"></span><span class="tcount"></span>` +
    `<button class="tclose" aria-label="Close workspace">${KILL_SVG}</button>`;
  tabEl.querySelector(".tname")!.textContent = wsName;
  tabEl.dataset.ws = id;
  tabstrip.insertBefore(tabEl, tabAdd);
```

with:

```ts
  const tabEl = document.createElement("div");
  tabEl.className = "proj";
  tabEl.innerHTML =
    `<span class="tdot"></span><span class="tname"></span><span class="tcount"></span>` +
    `<button class="tclose" aria-label="Close workspace">${KILL_SVG}</button>`;
  tabEl.querySelector(".tname")!.textContent = wsName;
  tabEl.dataset.ws = id;
  railList.appendChild(tabEl);
```

- [ ] **Step 7: Confirm the rail add button works via the alias** — the existing handler at `src/main.ts:1934` is `tabAdd?.addEventListener("click", () => openWizard());`. Because `tabAdd` is now aliased to `railAdd` (Step 5), this handler already wires the rail's "+" to open the spawn wizard — no change needed. Just verify the line still references `tabAdd` and leave it as-is.

- [ ] **Step 8: Flip the drag axis to vertical** — in `wireTabDrag` (`src/main.ts:433-440`), replace the horizontal midpoint test:

```ts
    const r = el.getBoundingClientRect();
    const before = e.clientX - r.left < r.width / 2; // left half → drop before
    tabstrip.insertBefore(tabDragSrc.tabEl, before ? el : el.nextSibling);
```

with the vertical one:

```ts
    const r = el.getBoundingClientRect();
    const before = e.clientY - r.top < r.height / 2; // top half → drop before
    railList.insertBefore(tabDragSrc.tabEl, before ? el : el.nextSibling);
```

- [ ] **Step 9: Update `commitTabOrder` to read the rail** — in `src/main.ts:446-456`, replace the query selector line:

```ts
  tabstrip.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
```

with:

```ts
  railList.querySelectorAll<HTMLElement>(".proj").forEach((t) => {
```

- [ ] **Step 10: Typecheck + run existing tests**

Run: `npx tsc --noEmit` then `npx vitest run`
Expected: typecheck clean; all existing unit tests (including `workspaces.test.ts`) still pass (they test pure helpers, unaffected).

- [ ] **Step 11: Visually verify**

Run: `npm run tauri dev`
Expected: workspaces now appear as a vertical list in the left rail; clicking activates, double-click renames, the ✕ closes, the rail "+" creates a new project, dragging a row reorders it, and dragging a row out of the window still detaches it into its own Maestro window.

- [ ] **Step 12: Commit**

```bash
git add index.html src/styles/sidebar.css src/styles/index.css src/main.ts
git commit -m "feat(sidebar): vertical project rail replaces tab strip"
```

---

### Task 7: Frontend — lazy file tree in the code panel

**Files:**
- Create: `src/filetree.ts`
- Create: `src/styles/filetree.css`
- Modify: `src/styles/index.css` (add `@import "./filetree.css";`)
- Modify: `src/main.ts` (init the tree at startup; re-root it in `activateWorkspace`)

**Interfaces:**
- Consumes: `fsReadDir` (ipc), `filterEntries`, `sortEntries` (codepanel), `FsEntry` (ipc).
- Produces: `initFileTree(opts: { host: HTMLElement; onOpenFile: (relPath: string) => void }): { setRoot(dir: string | null): void }`. `relPath` uses backslashes relative to the workspace root (e.g. `src\main.ts`).

- [ ] **Step 1: Create `src/filetree.ts`**

```ts
// Lazy file tree for the active workspace folder. Reads one directory level at a
// time via fs_read_dir; expanding a folder fetches its children on demand. No
// drag in v1 — click a folder to expand, click a file to open it in the editor.
import { fsReadDir, type FsEntry } from "./ipc";
import { filterEntries, sortEntries } from "./codepanel";

interface FileTreeOpts {
  host: HTMLElement;
  onOpenFile: (relPath: string) => void;
}

const CHEVRON =
  '<svg class="tw-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

export function initFileTree(opts: FileTreeOpts): { setRoot(dir: string | null): void } {
  const { host, onOpenFile } = opts;
  let root: string | null = null;
  let showHidden = false;

  /** Join a parent rel path with a child name (backslash, Windows). */
  const joinRel = (rel: string, name: string) => (rel ? `${rel}\\${name}` : name);

  async function renderInto(container: HTMLElement, rel: string): Promise<void> {
    if (!root) return;
    let entries: FsEntry[];
    try {
      entries = await fsReadDir(root, rel || ".");
    } catch {
      container.innerHTML = `<div class="tw-msg">Cannot read folder</div>`;
      return;
    }
    const list = sortEntries(filterEntries(entries, showHidden));
    container.replaceChildren();
    for (const ent of list) {
      const row = document.createElement("div");
      row.className = ent.is_dir ? "tw-row tw-dir" : "tw-row tw-file";
      const childRel = joinRel(rel, ent.name);
      row.innerHTML =
        (ent.is_dir ? CHEVRON : `<span class="tw-chev tw-spacer"></span>`) +
        `<span class="tw-name"></span>`;
      row.querySelector(".tw-name")!.textContent = ent.name;
      container.appendChild(row);

      if (ent.is_dir) {
        const kids = document.createElement("div");
        kids.className = "tw-kids";
        kids.hidden = true;
        container.appendChild(kids);
        let loaded = false;
        row.addEventListener("click", () => {
          const open = kids.hidden;
          kids.hidden = !open;
          row.classList.toggle("open", open);
          if (open && !loaded) {
            loaded = true;
            void renderInto(kids, childRel);
          }
        });
      } else {
        row.addEventListener("click", () => {
          host.querySelectorAll(".tw-row.sel").forEach((n) => n.classList.remove("sel"));
          row.classList.add("sel");
          onOpenFile(childRel);
        });
      }
    }
  }

  function setRoot(dir: string | null): void {
    root = dir;
    host.replaceChildren();
    if (!dir) {
      host.innerHTML = `<div class="tw-msg">No folder for this workspace</div>`;
      return;
    }
    const rootBox = document.createElement("div");
    rootBox.className = "tw-root";
    host.appendChild(rootBox);
    void renderInto(rootBox, "");
  }

  return { setRoot };
}
```

- [ ] **Step 2: Create `src/styles/filetree.css`**

```css
/* File tree rows in the code panel's upper pane. */
.file-tree{font-size:12.5px;color:var(--text-2);padding:4px 0}
.tw-msg{padding:14px;color:var(--muted-2);font-size:12px;text-align:center}
.tw-row{display:flex;align-items:center;gap:4px;height:24px;padding:0 8px;cursor:pointer;white-space:nowrap;border-radius:5px}
.tw-row:hover{background:var(--surface-1)}
.tw-row.sel{background:var(--surface-2);color:var(--text)}
.tw-chev{flex:none;color:var(--muted-2);transition:transform .12s}
.tw-spacer{width:12px;height:12px;display:inline-block}
.tw-row.open > .tw-chev{transform:rotate(90deg)}
.tw-name{overflow:hidden;text-overflow:ellipsis}
.tw-dir .tw-name{color:var(--text-2);font-weight:500}
.tw-kids{margin-left:13px;border-left:1px solid var(--line)}
```

- [ ] **Step 3: Register the stylesheet** — add to `src/styles/index.css` after `sidebar.css`:

```css
@import "./filetree.css";
```

- [ ] **Step 4: Init the tree at startup** — in `src/main.ts`, add the import after `import { initPanels } from "./panels";` (from Task 5):

```ts
import { initFileTree } from "./filetree";
```

In the startup block (next to `initPanels()`), add — note the editor wiring comes in Task 8, so for now `onOpenFile` just logs:

```ts
  const fileTree = initFileTree({
    host: document.getElementById("fileTree") as HTMLElement,
    onOpenFile: (rel) => console.log("open file:", rel),
  });
```

Make `fileTree` reachable from `activateWorkspace`. If the startup block is below `activateWorkspace`'s definition, declare a module-level holder near the other `let` declarations (around `src/main.ts:117`):

```ts
let fileTree: { setRoot(dir: string | null): void } | null = null;
```

and assign it in the startup block instead of re-declaring:

```ts
  fileTree = initFileTree({
    host: document.getElementById("fileTree") as HTMLElement,
    onOpenFile: (rel) => console.log("open file:", rel),
  });
```

- [ ] **Step 5: Re-root the tree on workspace activation** — in `activateWorkspace` (`src/main.ts:216-226`), after the existing `dockSetContext({ key: ws.dir || ws.id, dir: ws.dir });` line, add:

```ts
  fileTree?.setRoot(ws.dir);
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Visually verify**

Run: `npm run tauri dev`. Spawn or open a workspace with a folder.
Expected: the code panel's upper pane shows the folder's tree; `node_modules`/`.git`/`target` are hidden; folders expand lazily on click and load their children; clicking a file logs its relative path to the console; switching projects re-roots the tree; a workspace with no folder shows "No folder for this workspace".

- [ ] **Step 8: Commit**

```bash
git add src/filetree.ts src/styles/filetree.css src/styles/index.css src/main.ts
git commit -m "feat(filetree): lazy folder tree in the code panel"
```

---

### Task 8: Frontend — CodeMirror editor with save + conflict guard

**Files:**
- Modify: `package.json` (add CodeMirror dependencies)
- Create: `src/editor.ts`
- Create: `src/styles/editor.css`
- Modify: `src/styles/index.css` (add `@import "./editor.css";`)
- Modify: `src/main.ts` (init editor; wire tree `onOpenFile` to it)

**Interfaces:**
- Consumes: `fsReadFile`, `fsWriteFile`, `fsStat` (ipc); `langForFile`, `resolveConflict` (codepanel).
- Produces: `initEditor(opts: { host: HTMLElement; getRoot: () => string | null }): { open(relPath: string): Promise<void> }`.

- [ ] **Step 1: Add CodeMirror dependencies**

Run:
```bash
npm install codemirror@^6.0.1 @codemirror/state@^6 @codemirror/view@^6 @codemirror/commands@^6 @codemirror/lang-javascript@^6 @codemirror/lang-json@^6 @codemirror/lang-css@^6 @codemirror/lang-html@^6 @codemirror/lang-markdown@^6 @codemirror/lang-rust@^6 @codemirror/lang-python@^6 @codemirror/lang-yaml@^6
```
Expected: dependencies added to `package.json`; `package-lock.json` updated.

- [ ] **Step 2: Create `src/editor.ts`**

```ts
// Lightweight CodeMirror 6 editor for the code panel. Opens one file at a time,
// saves with Ctrl+S, and guards against clobbering edits an agent made to the
// same file on disk (mtime conflict → banner with Reload / Overwrite).
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { fsReadFile, fsWriteFile, fsStat } from "./ipc";
import { langForFile, resolveConflict } from "./codepanel";

interface EditorOpts {
  host: HTMLElement;
  getRoot: () => string | null;
}

/** Map a codepanel language key to a CodeMirror language extension. */
function langExtension(lang: string) {
  switch (lang) {
    case "javascript": return javascript({ jsx: true });
    case "typescript": return javascript({ jsx: true, typescript: true });
    case "json": return json();
    case "css": return css();
    case "html": return html();
    case "markdown": return markdown();
    case "rust": return rust();
    case "python": return python();
    case "yaml": return yaml();
    default: return [];
  }
}

const POLL_MS = 3000;

export function initEditor(opts: EditorOpts): { open(relPath: string): Promise<void> } {
  const { host, getRoot } = opts;

  // Banner + editor mount.
  const banner = document.createElement("div");
  banner.className = "ed-banner";
  banner.hidden = true;
  const mount = document.createElement("div");
  mount.className = "ed-mount";
  const empty = document.createElement("div");
  empty.className = "ed-empty";
  empty.textContent = "Select a file to edit";
  host.replaceChildren(banner, empty, mount);

  const langComp = new Compartment();
  let view: EditorView | null = null;
  let openRel: string | null = null;
  let openRoot: string | null = null;
  let diskMtime = 0;
  let saved = ""; // last-saved/loaded doc text — dirty = current !== saved
  let pollTimer: number | null = null;

  const current = () => view?.state.doc.toString() ?? "";
  const isDirty = () => current() !== saved;

  function setBanner(html: string | null): void {
    if (!html) { banner.hidden = true; banner.replaceChildren(); return; }
    banner.hidden = false;
    banner.innerHTML = html;
  }

  async function doSave(force: boolean): Promise<void> {
    if (!openRel || !openRoot) return;
    try {
      const res = await fsWriteFile(openRoot, openRel, current(), force ? null : diskMtime);
      diskMtime = res.mtime;
      saved = current();
      setBanner(null);
      renderDirty();
    } catch (err) {
      // A Conflict error serializes as { Conflict: <mtime> }.
      const conflictMtime = (err as { Conflict?: number })?.Conflict;
      if (typeof conflictMtime === "number") {
        diskMtime = conflictMtime;
        setBanner(
          `File changed on disk. <button data-ed="overwrite">Overwrite</button> <button data-ed="reload">Reload</button>`,
        );
      } else {
        setBanner(`Save failed.`);
      }
    }
  }

  async function reload(): Promise<void> {
    if (!openRel || !openRoot || !view) return;
    const f = await fsReadFile(openRoot, openRel);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.content } });
    diskMtime = f.mtime;
    saved = f.content;
    setBanner(null);
    renderDirty();
  }

  function renderDirty(): void {
    host.classList.toggle("ed-dirty", isDirty());
  }

  banner.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).dataset.ed;
    if (act === "overwrite") void doSave(true);
    else if (act === "reload") void reload();
  });

  async function poll(): Promise<void> {
    if (!openRel || !openRoot) return;
    try {
      const s = await fsStat(openRoot, openRel);
      if (s.mtime === diskMtime) return;
      const action = resolveConflict(true, isDirty());
      if (action === "reload") await reload();
      else if (action === "banner") {
        diskMtime = s.mtime; // record so we don't re-prompt every tick
        setBanner(
          `File changed on disk. <button data-ed="overwrite">Overwrite</button> <button data-ed="reload">Reload</button>`,
        );
      }
    } catch {
      /* file vanished or unreadable — leave the buffer as-is */
    }
  }

  async function open(relPath: string): Promise<void> {
    const root = getRoot();
    if (!root) return;
    let f: { content: string; mtime: number };
    try {
      f = await fsReadFile(root, relPath);
    } catch {
      empty.hidden = false;
      mount.hidden = true;
      empty.textContent = "Can't open this file (binary or too large)";
      return;
    }
    empty.hidden = true;
    mount.hidden = false;
    openRel = relPath;
    openRoot = root;
    diskMtime = f.mtime;
    saved = f.content;
    setBanner(null);

    const saveKey = keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => { void doSave(false); return true; },
      },
    ]);
    const state = EditorState.create({
      doc: f.content,
      extensions: [
        basicSetup,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        saveKey,
        langComp.of(langExtension(langForFile(relPath))),
        EditorView.updateListener.of((u) => { if (u.docChanged) renderDirty(); }),
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
      ],
    });
    if (view) view.destroy();
    view = new EditorView({ state, parent: mount });
    renderDirty();

    if (pollTimer === null) {
      pollTimer = window.setInterval(() => void poll(), POLL_MS);
      window.addEventListener("focus", () => void poll());
    }
  }

  return { open };
}
```

- [ ] **Step 3: Create `src/styles/editor.css`**

```css
/* CodeMirror editor host (lower pane of the code panel). */
.editor-host{display:flex;flex-direction:column}
.editor-host .ed-banner{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;color:#ffd9a0;background:rgba(255,184,76,.12);border-bottom:1px solid rgba(255,184,76,.3)}
.editor-host .ed-banner[hidden]{display:none}
.editor-host .ed-banner button{font:inherit;font-size:11px;padding:2px 8px;border-radius:5px;border:1px solid var(--line-strong);background:var(--surface-2);color:var(--text-2);cursor:pointer}
.editor-host .ed-banner button:hover{border-color:var(--accent-dim);color:var(--accent)}
.editor-host .ed-empty{flex:1;display:grid;place-items:center;color:var(--muted-2);font-size:12px}
.editor-host .ed-empty[hidden]{display:none}
.editor-host .ed-mount{flex:1;min-height:0;overflow:hidden}
.editor-host .ed-mount[hidden]{display:none}
.editor-host .cm-editor{height:100%;font-size:12.5px}
.editor-host .cm-editor.cm-focused{outline:none}
/* dirty dot on the panel title is optional; class hook is here for it */
.code-panel.ed-dirty .editor-host::before{content:"●";position:absolute;top:6px;right:10px;color:var(--accent);font-size:10px;z-index:2}
```

- [ ] **Step 4: Register the stylesheet** — add to `src/styles/index.css` after `filetree.css`:

```css
@import "./editor.css";
```

- [ ] **Step 5: Init the editor and wire the tree to it** — in `src/main.ts`, add the import after `import { initFileTree } from "./filetree";`:

```ts
import { initEditor } from "./editor";
```

In the startup block, create the editor **before** the tree and pass its `open` as `onOpenFile` (replacing the Task 7 `console.log` placeholder):

```ts
  const editor = initEditor({
    host: document.getElementById("editorHost") as HTMLElement,
    getRoot: () => activeWs?.dir ?? null,
  });
  fileTree = initFileTree({
    host: document.getElementById("fileTree") as HTMLElement,
    onOpenFile: (rel) => void editor.open(rel),
  });
```

- [ ] **Step 6: Typecheck + run all unit tests**

Run: `npx tsc --noEmit` then `npx vitest run`
Expected: typecheck clean; all tests pass.

- [ ] **Step 7: Visually verify the full flow**

Run: `npm run tauri dev`.
Expected:
1. Click a file in the tree → it opens in CodeMirror with syntax highlighting.
2. Edit → the dirty dot appears.
3. `Ctrl+S` → saves to disk, dirty dot clears.
4. With the file open, modify it from an external editor (or let an agent touch it): if you have no unsaved edits it silently reloads; if you do, a "File changed on disk" banner offers Reload / Overwrite.
5. Saving after an external change (with unsaved edits) shows the same conflict banner instead of clobbering.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/editor.ts src/styles/editor.css src/styles/index.css src/main.ts
git commit -m "feat(editor): CodeMirror editor with save + mtime conflict guard"
```

---

## Self-Review

**Spec coverage:**
- Layout 4-column grid → Task 5. ✓
- Project rail replacing tabs, keep detach → Task 6 (reuses `detachWorkspace`/`mergeWorkspaceToMain`). ✓
- Lazy file tree, hide heavy dirs, re-root on activate, no-folder empty state → Task 7 + Task 4 helpers. ✓
- Lightweight editor, syntax by extension, Ctrl+S, dirty, external-change/conflict → Task 8 + Task 4 helpers. ✓
- Backend fs commands, path scoping, binary/oversize refusal, mtime conflict → Tasks 1–3. ✓
- Tests: TS pure helpers (Task 4) + splitter clamp (Task 5) + Rust scoping/binary/conflict (Tasks 1–3). ✓
- CodeMirror dependency → Task 8 Step 1. ✓
- New CSS modules imported in index.css → Tasks 5–8. ✓

**Placeholder scan:** No "TBD"/"handle errors"-style gaps; every code step shows concrete code; the only intentional throwaway is the Task 7 `console.log` `onOpenFile`, explicitly replaced in Task 8 Step 5.

**Type consistency:** `FsEntry` defined once in `ipc.ts`, type-only-imported by `codepanel.ts`/`filetree.ts`. `mtime` is `number` (TS) / `i64` (Rust) everywhere. `fsWriteFile(..., expectedMtime: number|null)` matches Rust `expected_mtime: Option<i64>` (Tauri camelCases `expected_mtime`→`expectedMtime`). The `Conflict` error reads as `{Conflict:number}` in `editor.ts`, matching the serde enum shape `{"Conflict":<i64>}`. `initFileTree`/`initEditor`/`initPanels` signatures are consistent between their definition tasks and their `main.ts` call sites.

## Notes / risks for the implementer

- **Detached windows** also render the 4-column layout; the tree/editor simply re-root to that window's workspace dir. No special-casing needed, but verify `initPanels`/`initFileTree`/`initEditor` run in the detached boot path too (they live in the shared startup block).
- **`startTabRename`** (`src/main.ts:460+`) sets `draggable="false"` on `tabEl` during edit and writes `.tname`; it works unchanged on the `.proj` row. Verify the inline input width (`.tname-edit{width:100%}` in sidebar.css) looks right in the narrower rail.
- If `npm install` resolves a CodeMirror lang package to a name with no `@6` line, pin to the latest `6.x` published — all official `@codemirror/lang-*` are on v6.
- The Task 6 alias (`const tabstrip = railList`) keeps churn low; a follow-up cleanup could rename `tabEl`→`railEl` and `tabstrip`→`railList` throughout, but that is out of scope here.
