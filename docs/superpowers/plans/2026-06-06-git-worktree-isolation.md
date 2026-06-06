# Git Worktree Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run each agent in its own `git worktree` + branch when its workspace is a single git repo, so each agent's changes are isolated (the prerequisite for per-agent diff review).

**Architecture:** A Rust `worktree` module shells out to system `git` (`rev-parse`, `worktree add/remove`) and exposes three Tauri commands. Worktrees live on the repo's own drive under a hidden root (`<drive>:\.maestro-worktrees\<repo-slug>\<branch>`). The frontend detects the repo root when a workspace is created from a dir, shows an "Isolate" toggle in the spawn modal (default ON for git repos), and — when isolated — creates a worktree per agent and points that agent's PTY `cwd` at it. Worktrees persist after pane close (cleanup is Phase B).

**Tech Stack:** Rust (Tauri commands, `std::process::Command`, `tempfile` dev-dep for tests), TypeScript (vitest pure-unit tests), existing `ipc.ts` / `main.ts` patterns.

**Spec:** `docs/superpowers/specs/2026-06-06-git-worktree-isolation-design.md`

---

## File Structure

- `src-tauri/src/worktree.rs` — **new**: git helpers + path computation + 3 commands (`git_repo_root`, `worktree_add`, `worktree_remove`) + Rust unit/integration tests.
- `src-tauri/src/lib.rs` — modify: `pub mod worktree;` + register the 3 commands.
- `src-tauri/Cargo.toml` — modify: add `tempfile` to `[dev-dependencies]`.
- `src/worktree.ts` — **new**: pure TS helpers (`slug`, `branchName`).
- `src/worktree.test.ts` — **new**: vitest unit tests for the helpers.
- `src/ipc.ts` — modify: add `gitRepoRoot`, `worktreeAdd`, `worktreeRemove` wrappers.
- `src/main.ts` — modify: extend `Workspace` (`repoRoot`, `isolated`) and `AgentSpec` (`worktree?`, `branch?`); detect repo root at spawn; create a worktree per agent before boot; show a branch badge.
- `index.html` — modify: add the "Isolate each agent…" toggle to the spawn modal.

---

## Task 1: Rust path computation helper

**Files:**
- Create: `src-tauri/src/worktree.rs`
- Modify: `src-tauri/Cargo.toml` (dev-dep), `src-tauri/src/lib.rs` (module decl)

- [ ] **Step 1: Declare the module so the test compiles**

In `src-tauri/src/lib.rs`, add after the existing `pub mod` lines (currently `pub mod commands; pub mod core; pub mod error; pub mod state;`):

```rust
pub mod worktree;
```

- [ ] **Step 2: Write `worktree.rs` with the path helper + a failing test**

Create `src-tauri/src/worktree.rs`:

```rust
use std::path::{Path, PathBuf};

/// A short, stable, filesystem-safe slug for an arbitrary string.
fn slug(s: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// djb2 hash → 6-char base36, so two repos with the same folder name don't collide.
fn short_hash(s: &str) -> String {
    let mut h: u64 = 5381;
    for b in s.bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as u64);
    }
    let mut n = h % 36u64.pow(6);
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut buf = [b'0'; 6];
    for i in (0..6).rev() {
        buf[i] = digits[(n % 36) as usize];
        n /= 36;
    }
    String::from_utf8(buf.to_vec()).unwrap()
}

/// Compute the worktree directory for a repo + branch:
/// `<drive>:\.maestro-worktrees\<repo-slug>-<hash>\<branch-slug>`.
/// The root sits on the repo's own drive (never C:/profile) and out of the repo tree.
pub fn worktree_path_for(repo_root: &str, branch: &str) -> PathBuf {
    let root = Path::new(repo_root);
    let repo_name = root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".into());
    // Drive prefix on Windows (e.g. "D:"); fall back to the path root otherwise.
    let drive = repo_root.get(0..2).filter(|d| d.ends_with(':')).unwrap_or("");
    let folder = format!("{}-{}", slug(&repo_name), short_hash(repo_root));
    let mut p = PathBuf::new();
    p.push(format!("{}\\", drive));
    p.push(".maestro-worktrees");
    p.push(folder);
    p.push(slug(branch));
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_lives_on_repo_drive_under_hidden_root() {
        let p = worktree_path_for("D:\\WhaleloSource\\payments-svc", "maestro/claude-a1b2")
            .to_string_lossy()
            .to_string();
        assert!(p.starts_with("D:\\.maestro-worktrees\\"), "got {p}");
        assert!(p.contains("payments-svc-"), "got {p}");
        assert!(p.ends_with("maestro-claude-a1b2"), "got {p}");
    }

    #[test]
    fn same_name_different_path_differ() {
        let a = worktree_path_for("D:\\a\\app", "maestro/x");
        let b = worktree_path_for("D:\\b\\app", "maestro/x");
        assert_ne!(a, b);
    }
}
```

- [ ] **Step 3: Add the `tempfile` dev-dependency (needed by later git tests)**

In `src-tauri/Cargo.toml`, under `[dev-dependencies]` add:

```toml
tempfile = "3"
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `cd src-tauri && cargo test worktree::tests::path -- --nocapture`
Expected: both `path_lives_on_repo_drive_under_hidden_root` and `same_name_different_path_differ` PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/worktree.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(worktree): path computation helper + tests"
```

---

## Task 2: `git_repo_root` command + integration test

**Files:**
- Modify: `src-tauri/src/worktree.rs`

- [ ] **Step 1: Add the command + a failing integration test**

Append to `src-tauri/src/worktree.rs` (above the `#[cfg(test)]` module add the command; inside the test module add the test):

Command (add near the top, after the helpers):

```rust
use crate::error::CommandError;
use std::process::Command;

fn git(args: &[&str], cwd: &str) -> Result<String, CommandError> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| CommandError::Failed(format!("git not available: {e}")))?;
    if !out.status.success() {
        return Err(CommandError::Failed(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Return the repo root if `dir` is inside a single git repo, else `None`
/// (a non-git folder, or a parent that merely *contains* repos).
#[tauri::command]
pub fn git_repo_root(dir: String) -> Option<String> {
    git(&["rev-parse", "--show-toplevel"], &dir)
        .ok()
        .map(|p| p.replace('/', "\\"))
}
```

Test (inside `mod tests`):

```rust
fn init_repo(dir: &std::path::Path) {
    let d = dir.to_str().unwrap();
    git(&["init", "-q"], d).unwrap();
    git(&["config", "user.email", "t@t.dev"], d).unwrap();
    git(&["config", "user.name", "t"], d).unwrap();
    std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
    git(&["add", "-A"], d).unwrap();
    git(&["commit", "-qm", "init"], d).unwrap();
}

#[test]
fn repo_root_detects_git_and_rejects_plain() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("proj");
    std::fs::create_dir(&repo).unwrap();
    init_repo(&repo);
    let got = git_repo_root(repo.to_string_lossy().to_string());
    assert!(got.is_some());

    let plain = tmp.path().join("plain");
    std::fs::create_dir(&plain).unwrap();
    assert!(git_repo_root(plain.to_string_lossy().to_string()).is_none());
}
```

- [ ] **Step 2: Run the test — expect PASS**

Run: `cd src-tauri && cargo test worktree::tests::repo_root -- --nocapture`
Expected: PASS (requires `git` on PATH).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/worktree.rs
git commit -m "feat(worktree): git_repo_root command + integration test"
```

---

## Task 3: `worktree_add` / `worktree_remove` commands + test

**Files:**
- Modify: `src-tauri/src/worktree.rs`

- [ ] **Step 1: Add both commands**

Append to `src-tauri/src/worktree.rs` (after `git_repo_root`):

```rust
/// Create a worktree on a new branch off HEAD. Returns the worktree path.
#[tauri::command]
pub fn worktree_add(repo_root: String, branch: String) -> Result<String, CommandError> {
    let path = worktree_path_for(&repo_root, &branch);
    let path_str = path.to_string_lossy().to_string();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CommandError::Failed(format!("mkdir worktree root: {e}")))?;
    }
    git(
        &["worktree", "add", "-b", &branch, &path_str, "HEAD"],
        &repo_root,
    )?;
    Ok(path_str)
}

/// Remove a worktree (and optionally delete its branch).
#[tauri::command]
pub fn worktree_remove(
    repo_root: String,
    path: String,
    branch: Option<String>,
) -> Result<(), CommandError> {
    git(&["worktree", "remove", "--force", &path], &repo_root)?;
    if let Some(b) = branch {
        let _ = git(&["branch", "-D", &b], &repo_root); // best-effort
    }
    Ok(())
}
```

- [ ] **Step 2: Add the round-trip test (inside `mod tests`)**

```rust
#[test]
fn worktree_add_then_remove_round_trips() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("proj");
    std::fs::create_dir(&repo).unwrap();
    init_repo(&repo);
    let root = repo.to_string_lossy().to_string();

    // Note: worktree_path_for puts the tree on the repo's drive; for the test we
    // verify the branch+worktree are created and listed, then removed.
    let wt = worktree_add(root.clone(), "maestro/test-1".into()).expect("add");
    assert!(std::path::Path::new(&wt).join("a.txt").exists());
    let list = git(&["worktree", "list"], &root).unwrap();
    assert!(list.contains("maestro/test-1") || list.contains(&wt));

    worktree_remove(root.clone(), wt.clone(), Some("maestro/test-1".into())).expect("remove");
    assert!(!std::path::Path::new(&wt).exists());
}
```

- [ ] **Step 3: Run the test — expect PASS**

Run: `cd src-tauri && cargo test worktree::tests::worktree_add_then_remove -- --nocapture`
Expected: PASS. (If the sandbox can't write to the repo's drive root, this test is environment-sensitive; run on the dev machine.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/worktree.rs
git commit -m "feat(worktree): worktree_add/worktree_remove commands + round-trip test"
```

---

## Task 4: Register commands in the Tauri handler

**Files:**
- Modify: `src-tauri/src/lib.rs:15-21` (the `invoke_handler` macro)

- [ ] **Step 1: Add the three commands to `generate_handler!`**

In `src-tauri/src/lib.rs`, change the handler list (currently ending with `commands::set_tray_tooltip,`) to also include:

```rust
            commands::set_tray_tooltip,
            worktree::git_repo_root,
            worktree::worktree_add,
            worktree::worktree_remove,
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Finished with no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(worktree): register worktree commands"
```

---

## Task 5: TS branch-name helper (pure) + tests

**Files:**
- Create: `src/worktree.ts`, `src/worktree.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/worktree.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { slug, branchName } from "./worktree";

describe("slug", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slug("Claude Code #1")).toBe("claude-code-1");
    expect(slug("  weird//name__")).toBe("weird-name");
  });
});

describe("branchName", () => {
  it("namespaces under maestro/ with a short id suffix", () => {
    expect(branchName("Claude Code", "a1b2c3")).toBe("maestro/claude-code-a1b2c3");
  });
  it("never produces an empty segment", () => {
    expect(branchName("", "x9")).toBe("maestro/agent-x9");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `npm run test -- worktree`
Expected: FAIL ("Cannot find module './worktree'").

- [ ] **Step 3: Implement `src/worktree.ts`**

```ts
/* Pure helpers for git worktree isolation (branch naming). Path computation
 * lives in Rust (worktree.rs) since it creates the directory. */

/** Filesystem/branch-safe slug: lowercase, non-alphanumerics → single dash. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Branch for an agent: `maestro/<name-slug>-<shortId>` (collision-resistant). */
export function branchName(agentName: string, shortId: string): string {
  const base = slug(agentName) || "agent";
  return `maestro/${base}-${shortId}`;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm run test -- worktree`
Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts src/worktree.test.ts
git commit -m "feat(worktree): branch-name helper + tests"
```

---

## Task 6: ipc.ts wrappers

**Files:**
- Modify: `src/ipc.ts` (add after the existing `setTrayTooltip` / `notify` exports)

- [ ] **Step 1: Add the three wrappers**

Append to `src/ipc.ts`:

```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ipc.ts
git commit -m "feat(worktree): ipc wrappers for git/worktree commands"
```

---

## Task 7: Spawn-modal "Isolate" toggle (markup + state)

**Files:**
- Modify: `index.html` (spawn modal body, after the `.perm-toggle` block, before `.crew-total`)
- Modify: `src/main.ts` (read the toggle in `openModal` / `spawnFromModal`)

- [ ] **Step 1: Add the toggle markup**

In `index.html`, immediately after the existing `</label>` that closes the `mSkipPerms` `.perm-toggle` and before `<div class="crew-total">`, insert:

```html
      <label class="perm-toggle" for="mIsolate" id="mIsolateRow" hidden>
        <input type="checkbox" id="mIsolate" checked>
        <span class="pt-sw"></span>
        <span class="pt-text">
          <b>Isolate each agent in its own git worktree</b>
          <span>Each agent works on its own branch off HEAD, so changes are reviewable per agent. Only available when the folder is a git repo.</span>
        </span>
      </label>
```

- [ ] **Step 2: Show the toggle only for git-repo dirs; wire mDir changes**

In `src/main.ts`, add near the other modal element refs (after `const mSkipPerms = ... ;`):

```ts
const mIsolate = document.getElementById("mIsolate") as HTMLInputElement;
const mIsolateRow = document.getElementById("mIsolateRow") as HTMLElement;

// Reveal the isolate toggle only when the working directory is a single git repo.
async function refreshIsolateToggle() {
  const dir = mDir.value.trim();
  let isRepo = false;
  if (dir) {
    try {
      isRepo = (await gitRepoRoot(dir)) !== null;
    } catch {
      isRepo = false;
    }
  }
  mIsolateRow.hidden = !isRepo;
}
mDir.addEventListener("change", () => void refreshIsolateToggle());
```

Add the import at the top of `main.ts` (extend the existing `./ipc` import list):

```ts
  gitRepoRoot,
  worktreeAdd,
```

And call `void refreshIsolateToggle();` at the end of `openModal(...)` (right after `renderCrew();`).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (the new symbols are used in Task 8 too).

- [ ] **Step 4: Commit**

```bash
git add index.html src/main.ts
git commit -m "feat(worktree): spawn-modal isolate toggle (git repos only)"
```

---

## Task 8: Wire isolation into workspace + agent boot

**Files:**
- Modify: `src/main.ts` — `Workspace` interface (73-80), `AgentSpec` (506-514), `spawnCrew` (~811), boot thunk (~574-599)

- [ ] **Step 1: Extend the types**

`Workspace` (lines 73-80) — add two fields:

```ts
interface Workspace {
  id: string;
  name: string;
  dir: string | null;
  repoRoot: string | null;   // git repo root when isolated; else null
  isolated: boolean;         // create a worktree per agent
  gridEl: HTMLElement;
  tabEl: HTMLElement;
  panes: Map<string, Pane>;
}
```

`AgentSpec` (lines 506-514) — add two optional fields:

```ts
interface AgentSpec {
  program: string;
  args: string[];
  cwd: string | null;
  name: string;
  badge: string;
  color: string;
  mono: string;
  worktree?: string;  // worktree path once created (isolated agents)
  branch?: string;    // the agent's git branch (isolated agents)
}
```

- [ ] **Step 2: Initialise the new Workspace fields**

In `createWorkspace` (line 129), where the workspace object is constructed (the `const ws = { ... }` / returned object), add `repoRoot: null,` and `isolated: false,`. (Locate the object literal that sets `id, name, dir, gridEl, tabEl, panes` and add the two fields.)

- [ ] **Step 3: Detect repo root + isolation in `spawnCrew`**

In `spawnCrew` (line ~811), after the workspace `ws` is chosen/created and `dir` is known (after the `const ws = mode === "current" && activeWs ? activeWs : createWorkspace(dir);` line), add:

```ts
  // Decide isolation once per spawn: only for a fresh git-repo workspace when
  // the modal's toggle is on. (Existing isolated workspaces keep their setting.)
  if (!ws.isolated && dir) {
    const root = await gitRepoRoot(dir).catch(() => null);
    if (root && !mIsolateRow.hidden && mIsolate.checked) {
      ws.repoRoot = root;
      ws.isolated = true;
    }
  }
```

- [ ] **Step 4: Create a worktree per agent before boot**

In the boot thunk inside `createAgent` (line ~574, the returned `async () => { ... }`), replace the start of the `try {` block so it provisions a worktree first. Change:

```ts
    try {
      const launch = launchSpec(spec.program, spec.args);
      await spawnPty(id, launch.program, launch.args, spec.cwd, cols, rows, (bytes) => {
```

to:

```ts
    try {
      // Isolated agents get their own worktree+branch; point the PTY cwd there.
      let cwd = spec.cwd;
      if (ws.isolated && ws.repoRoot && !spec.worktree) {
        try {
          spec.branch = branchName(spec.name, id.slice(-6));
          spec.worktree = await worktreeAdd(ws.repoRoot, spec.branch);
          cwd = spec.worktree;
          saveSession();
        } catch (e) {
          term.write(enc.encode(`\r\n\x1b[33m[worktree failed, using project dir: ${errMsg(e)}]\x1b[0m\r\n`));
        }
      } else if (spec.worktree) {
        cwd = spec.worktree;
      }
      const launch = launchSpec(spec.program, spec.args);
      await spawnPty(id, launch.program, launch.args, cwd, cols, rows, (bytes) => {
```

Add `branchName` and `worktreeAdd` to the imports (`./worktree` and `./ipc` respectively):

```ts
import { branchName } from "./worktree";
```
(`worktreeAdd` was already added to the `./ipc` import in Task 7.)

- [ ] **Step 5: Typecheck + run all tests**

Run: `npx tsc --noEmit && npm run test`
Expected: tsc clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat(worktree): isolate agents in per-agent worktrees on spawn"
```

---

## Task 9: Branch badge on isolated panes

**Files:**
- Modify: `src/main.ts` (`createAgent`, after a worktree is created) and reuse existing pane DOM.

- [ ] **Step 1: Show the branch under the pane sub-title when isolated**

In the boot thunk, right after `spec.worktree = await worktreeAdd(...)` succeeds, update the pane's sub label to show the branch. Add:

```ts
          const subEl = el.querySelector<HTMLElement>("[data-sub]");
          if (subEl && spec.branch) subEl.textContent = spec.branch;
```

(If the pane markup has no `[data-sub]` hook, set it on the existing sub element used by `createAgent` — the `sub` computed at line 527; add `data-sub` to that element in `buildPaneEl` so this selector resolves. Verify by reading `buildPaneEl`.)

- [ ] **Step 2: Verify in the running app (manual)**

Run: `npm run tauri dev`
Steps: New workspace → pick a git repo folder → confirm the "Isolate…" toggle shows and is ON → spawn 2 agents → each pane shows its `maestro/<name>-<id>` branch; run `git worktree list` in the repo and confirm two worktrees under `<drive>:\.maestro-worktrees\...`.
Expected: two isolated worktrees + branches; agents edit independently.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts index.html
git commit -m "feat(worktree): show per-agent branch badge on isolated panes"
```

---

## Self-Review notes

- **Spec coverage:** repo detection (T2), worktree create/remove (T3), location rule on repo drive/hidden root (T1), auto-on toggle for git repos (T7), per-agent cwd override (T8), branch naming (T5), indicator (T9), non-git fallback (T7 hides toggle + T8 keeps `spec.cwd`), git-missing fallback (commands return error → caught in T8). Multi-repo parent = `git_repo_root` returns null → no isolation (handled; per-sub-repo diffs are Phase B). Cleanup on close is intentionally deferred (Phase B).
- **Deviation from spec:** path computation lives in Rust (`worktree_path_for`, tested in T1) rather than a TS `worktreePathFor`, to keep one source of truth where the directory is actually created. TS unit tests cover `branchName`/`slug` instead.
- **Type consistency:** `gitRepoRoot`/`worktreeAdd`/`worktreeRemove` (ipc.ts) and `git_repo_root`/`worktree_add`/`worktree_remove` (Rust) names align; `Workspace.repoRoot`/`isolated` and `AgentSpec.worktree`/`branch` used consistently in T8/T9.
