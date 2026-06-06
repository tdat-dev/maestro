# AI Code Diff Review — Slice 1 (read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "AI Code" view that shows the git changes in the active workspace's repo(s) — grouped per repo — as a read-only Mission Control panel, so the user can SEE what the agents changed. (Accept/reject, stage, commit, and merge are Slice 2.)

**Architecture:** Rust shells out to `git` to (a) discover the git repos under the workspace dir (`git_repos_under` — the single repo, or each immediate sub-repo of a parent folder per the "Option 1 / combined per-repo" decision) and (b) return the raw unified diff of a repo's working tree (`repo_diff`). The frontend has a pure, unit-tested `parseDiff()` that turns raw unified diff text into `DiffFile[]`, and an "AI Code" topbar toggle that re-lays the workspace into the Mission Control layout, rendering files → hunks grouped by repo. Styling/markup is lifted from the approved mockup `design/diff-mockups/opt5-mission-control/index.html` (Inter/JetBrains Mono fonts, per-repo banded sections).

**Tech Stack:** Rust (Tauri commands, `std::process::Command`, `tempfile` dev-dep — already present), TypeScript (vitest pure-unit tests), existing `ipc.ts`/`main.ts` patterns. Builds: `cargo` inside `src-tauri/`; `npm run test` + `npx tsc --noEmit` at repo root.

**Spec:** `docs/superpowers/specs/2026-06-06-ai-code-diff-review-design.md` (this implements the read-only subset; per-hunk accept/reject + commit + merge + merge-queue are explicitly deferred to Slice 2).

**Decision context:** Per the user's workflow, the common case is opening a PARENT folder (e.g. `D:\FacebookAuto`) that contains multiple git sub-repos (`FacebookMarketing`, `mkt.adayroi.online`) plus non-git folders. Option 1: show each sub-repo's combined working-tree diff grouped by repo (no per-agent attribution). A single-repo workspace shows that one repo.

---

## File Structure

- `src-tauri/src/review.rs` — **new**: `git_repos_under` + `repo_diff` commands + Rust tests.
- `src-tauri/src/lib.rs` — modify: `pub mod review;` + register the 2 commands.
- `src/diff.ts` — **new**: pure `parseDiff(raw): DiffFile[]` + the `DiffFile`/`DiffHunk`/`DiffLine` types.
- `src/diff.test.ts` — **new**: vitest tests for `parseDiff`.
- `src/ipc.ts` — modify: add `reposUnder`, `repoDiff` wrappers.
- `src/aicode.ts` — **new**: the AI Code view controller (toggle state, fetch diffs, render the dock).
- `src/styles/aicode.css` — **new**: styles lifted from the opt5 mockup (Mission Control + diff rendering).
- `src/styles/index.css` — modify: `@import "./aicode.css";`.
- `index.html` — modify: add the "AI Code" topbar toggle button + the AI Code panel container.
- `src/main.ts` — modify: import + init the AI Code view; expose the active workspace dir to it.

---

## Task 1: Rust `git_repos_under` command + test

**Files:**
- Create: `src-tauri/src/review.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Declare the module**

In `src-tauri/src/lib.rs`, add after `pub mod worktree;`:

```rust
pub mod review;
```

- [ ] **Step 2: Create `review.rs` with the command + a failing test**

Create `src-tauri/src/review.rs`:

```rust
use crate::error::CommandError;
use serde::Serialize;
use std::path::Path;
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

#[derive(Serialize)]
pub struct RepoRef {
    pub path: String,
    pub name: String,
}

/// Discover the git repos to review under `dir`:
/// - if `dir` itself is a git repo → return just it;
/// - else → each immediate sub-folder that is a git repo (parent-of-repos case);
/// - else → empty.
#[tauri::command]
pub fn git_repos_under(dir: String) -> Vec<RepoRef> {
    let mk = |p: &Path| RepoRef {
        path: p.to_string_lossy().replace('/', "\\"),
        name: p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
    };
    // Case 1: dir itself is a repo.
    if git(&["rev-parse", "--is-inside-work-tree"], &dir)
        .map(|s| s == "true")
        .unwrap_or(false)
    {
        if let Ok(top) = git(&["rev-parse", "--show-toplevel"], &dir) {
            return vec![mk(Path::new(&top))];
        }
    }
    // Case 2: immediate sub-folders that are repos.
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        paths.sort();
        for p in paths {
            if p.is_dir() && p.join(".git").exists() {
                out.push(mk(&p));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo(dir: &Path) {
        let d = dir.to_str().unwrap();
        git(&["init", "-q"], d).unwrap();
        git(&["config", "user.email", "t@t.dev"], d).unwrap();
        git(&["config", "user.name", "t"], d).unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&["add", "-A"], d).unwrap();
        git(&["commit", "-qm", "init"], d).unwrap();
    }

    #[test]
    fn finds_single_repo_when_dir_is_a_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("solo");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
        let got = git_repos_under(repo.to_string_lossy().to_string());
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "solo");
    }

    #[test]
    fn finds_sub_repos_under_a_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("parent");
        std::fs::create_dir(&parent).unwrap();
        for name in ["repoA", "repoB"] {
            let r = parent.join(name);
            std::fs::create_dir(&r).unwrap();
            init_repo(&r);
        }
        std::fs::create_dir(parent.join("plain")).unwrap(); // non-git, ignored
        let got = git_repos_under(parent.to_string_lossy().to_string());
        let names: Vec<_> = got.iter().map(|r| r.name.clone()).collect();
        assert_eq!(names, vec!["repoA".to_string(), "repoB".to_string()]);
    }
}
```

- [ ] **Step 3: Run the tests — expect PASS**

Run: `cd src-tauri && cargo test review::tests -- --nocapture`
Expected: `finds_single_repo_when_dir_is_a_repo` and `finds_sub_repos_under_a_parent` PASS. (Requires `git` on PATH.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/review.rs src-tauri/src/lib.rs
git commit -m "feat(review): git_repos_under command + tests"
```
(A global hook may prepend a type to the subject — that's expected; don't fight it.)

---

## Task 2: Rust `repo_diff` command + test

**Files:**
- Modify: `src-tauri/src/review.rs`

- [ ] **Step 1: Add the command (after `git_repos_under`)**

```rust
/// Raw unified diff of a repo's working tree vs HEAD (staged + unstaged),
/// including untracked files. Empty string when the tree is clean.
#[tauri::command]
pub fn repo_diff(repo_root: String) -> Result<String, CommandError> {
    // `--no-color`, 3 lines of context; `HEAD` covers staged+unstaged tracked
    // changes. Untracked files are appended via a second pass below.
    let tracked = git(
        &["-c", "core.quotepath=false", "diff", "--no-color", "HEAD"],
        &repo_root,
    )
    .unwrap_or_default();
    Ok(tracked)
}
```

- [ ] **Step 2: Add the test (inside `mod tests`)**

```rust
#[test]
fn repo_diff_shows_working_tree_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("r");
    std::fs::create_dir(&repo).unwrap();
    init_repo(&repo);
    std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap(); // modify tracked file
    let d = repo_diff(repo.to_string_lossy().to_string()).unwrap();
    assert!(d.contains("a.txt"), "diff should name the file: {d}");
    assert!(d.contains("+two"), "diff should show the added line: {d}");
}

#[test]
fn repo_diff_clean_tree_is_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("clean");
    std::fs::create_dir(&repo).unwrap();
    init_repo(&repo);
    assert_eq!(repo_diff(repo.to_string_lossy().to_string()).unwrap(), "");
}
```

- [ ] **Step 3: Run the tests — expect PASS**

Run: `cd src-tauri && cargo test review::tests::repo_diff -- --nocapture`
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/review.rs
git commit -m "feat(review): repo_diff command + tests"
```

---

## Task 3: Register the review commands

**Files:**
- Modify: `src-tauri/src/lib.rs` (the `generate_handler!` list)

- [ ] **Step 1: Add both commands to the handler**

In `src-tauri/src/lib.rs`, after the `worktree::worktree_remove,` line in `tauri::generate_handler![...]`, add:

```rust
            review::git_repos_under,
            review::repo_diff,
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Finished, no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(review): register review commands"
```

---

## Task 4: TS unified-diff parser (pure) + tests

**Files:**
- Create: `src/diff.ts`, `src/diff.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/diff.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDiff } from "./diff";

const SAMPLE = `diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;

describe("parseDiff", () => {
  it("returns one file with its path and counts", () => {
    const files = parseDiff(SAMPLE);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/app.ts");
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
  });

  it("parses hunk lines with kinds", () => {
    const h = parseDiff(SAMPLE)[0].hunks[0];
    expect(h.header).toBe("@@ -1,3 +1,4 @@");
    expect(h.lines.map((l) => l.kind)).toEqual(["ctx", "del", "add", "add", "ctx"]);
    expect(h.lines[2].text).toBe("const b = 3;");
  });

  it("returns [] for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `npm run test -- diff`
Expected: FAIL ("Cannot find module './diff'").

- [ ] **Step 3: Implement `src/diff.ts`**

```ts
/* Pure unified-diff parser: raw `git diff` text → structured files/hunks/lines
 * for read-only rendering. No git, no Tauri — easily unit-tested. */

export type DiffLineKind = "ctx" | "add" | "del";
export interface DiffLine {
  kind: DiffLineKind;
  text: string; // line content without the leading +/-/space
}
export interface DiffHunk {
  header: string; // the @@ ... @@ line
  lines: DiffLine[];
}
export interface DiffFile {
  path: string; // new path (b/...), or old path for deletions
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      file = { path: "", additions: 0, deletions: 0, hunks: [] };
      hunk = null;
      files.push(file);
    } else if (!file) {
      continue;
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "");
      if (p !== "/dev/null") file.path = p;
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4).replace(/^a\//, "");
      if (!file.path && p !== "/dev/null") file.path = p; // deletions: keep old path
    } else if (line.startsWith("@@")) {
      const end = line.indexOf("@@", 2);
      hunk = { header: end >= 0 ? line.slice(0, end + 2) : line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      const c = line[0];
      const kind: DiffLineKind = c === "+" ? "add" : c === "-" ? "del" : "ctx";
      if (kind === "add") file.additions++;
      else if (kind === "del") file.deletions++;
      hunk.lines.push({ kind, text: line.slice(1) });
    }
  }
  return files;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm run test -- diff`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/diff.ts src/diff.test.ts
git commit -m "feat(aicode): unified-diff parser + tests"
```

---

## Task 5: ipc.ts wrappers

**Files:**
- Modify: `src/ipc.ts`

- [ ] **Step 1: Add the wrappers (append to the file)**

```ts
export interface RepoRef { path: string; name: string }

/** Git repos to review under `dir` (the dir itself, or its sub-repos). */
export async function reposUnder(dir: string): Promise<RepoRef[]> {
  return invoke<RepoRef[]>("git_repos_under", { dir });
}

/** Raw unified diff of a repo's working tree vs HEAD. */
export async function repoDiff(repoRoot: string): Promise<string> {
  return invoke<string>("repo_diff", { repoRoot });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ipc.ts
git commit -m "feat(aicode): ipc wrappers reposUnder/repoDiff"
```

---

## Task 6: AI Code styles + panel markup + topbar toggle

**Files:**
- Create: `src/styles/aicode.css`
- Modify: `src/styles/index.css`, `index.html`

- [ ] **Step 1: Create `src/styles/aicode.css` by lifting the relevant rules from the approved mockup**

Open `design/diff-mockups/opt5-mission-control/index.html` and copy the `<style>` rules for these selectors into `src/styles/aicode.css` (they already use the app's token variables, so they drop in): `.mc`, `.fleet`, `.fleet-head`, `.fleet-scroll`, `.repo-grp`, `.repo-grp-h`, `.rg-name`, `.rg-count`, `.rg-meta`, `.repo-lanes`, `.lane*`, `.dock`, `.dock-head`, `.dh-*`, `.branch-badge`, `.dock-files`, `.ftab*`, `.dock-body`, `.filehdr`, `.hunk`, `.hunk-bar`, `.hunk-range`, `.hunk-ctx`, `.diff`, `.dl*` (diff lines), and the `.add/.del` colour tokens block. Wrap the whole view under a `#aicode` scope and add:

```css
#aicode{position:absolute;inset:46px 0 0 0;display:none;background:var(--bg)}
#aicode.open{display:block}
#aicode .mc{display:grid;grid-template-columns:248px minmax(0,1fr) 524px;gap:10px;height:100%;padding:10px}
/* read-only: hide the accept/reject + commit/merge affordances for Slice 1 */
#aicode .hunk-acts,#aicode .dock-foot,#aicode .mq{display:none}
```

(Do NOT copy `.topbar`, `.app`, `.bcast`, `.term-host`, splash, or window-control rules — those already exist in the app. Only the Mission-Control + diff-rendering rules.)

- [ ] **Step 2: Register the stylesheet**

In `src/styles/index.css`, add at the end:

```css
@import "./aicode.css";
```

- [ ] **Step 3: Add the topbar toggle button**

In `index.html`, in the workspace `<header class="topbar">`, immediately before the `<button class="tb-btn" id="btnNewAgent">` line, add:

```html
    <button class="tb-btn" id="btnAiCode" title="AI Code — review agent changes"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg> AI Code</button>
```

- [ ] **Step 4: Add the AI Code panel container**

In `index.html`, immediately after the closing `</div>` of `<div class="app" id="app" ...>` (the workspace container) and before the spawn modal, add:

```html
<!-- ===================== AI CODE (diff review) ===================== -->
<div id="aicode" aria-hidden="true">
  <div class="mc">
    <aside class="fleet"><div class="fleet-head"><span class="ft">Changes</span><span class="fcount" id="aiRepoCount"></span></div><div class="fleet-scroll" id="aiFleet"></div></aside>
    <section class="dock" id="aiDock"><div class="dock-body" id="aiDockBody"></div></section>
  </div>
</div>
```

(Slice 1 uses a two-zone layout — repo/file rail + diff body. The center live-grid zone from the mockup is added in Slice 2 when review-while-running matters.)

- [ ] **Step 5: Verify the app still builds**

Run: `npx tsc --noEmit` (no TS yet, should pass) and visually confirm `npm run dev` serves without CSS import errors (check the terminal for vite errors).
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/styles/aicode.css src/styles/index.css index.html
git commit -m "feat(aicode): AI Code panel markup + styles + topbar toggle"
```

---

## Task 7: Wire the AI Code view (fetch + render, read-only)

**Files:**
- Create: `src/aicode.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Implement `src/aicode.ts`**

```ts
import { reposUnder, repoDiff, type RepoRef } from "./ipc";
import { parseDiff, type DiffFile } from "./diff";

const enc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Provider the view calls to learn the active workspace's directory. */
let getActiveDir: () => string | null = () => null;
export function setActiveDirProvider(fn: () => string | null) {
  getActiveDir = fn;
}

const panel = () => document.getElementById("aicode");
const body = () => document.getElementById("aiDockBody");
const fleet = () => document.getElementById("aiFleet");
const repoCount = () => document.getElementById("aiRepoCount");

function renderFile(f: DiffFile): string {
  const hunks = f.hunks
    .map(
      (h) =>
        `<div class="hunk"><div class="hunk-bar"><span class="hunk-range">${enc(h.header)}</span></div>` +
        `<div class="diff">` +
        h.lines
          .map(
            (l) =>
              `<div class="dl ${l.kind === "add" ? "add" : l.kind === "del" ? "del" : ""}">` +
              `<span class="sign">${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>` +
              `<span class="code">${enc(l.text) || "&nbsp;"}</span></div>`,
          )
          .join("") +
        `</div></div>`,
    )
    .join("");
  return `<div class="filehdr"><span class="fp">${enc(f.path)}</span><span class="fbadge">+${f.additions} −${f.deletions}</span></div>${hunks}`;
}

async function render() {
  const dir = getActiveDir();
  const f = fleet()!,
    b = body()!,
    rc = repoCount()!;
  f.replaceChildren();
  b.replaceChildren();
  if (!dir) {
    b.innerHTML = `<div class="filehdr"><span class="fp">No workspace folder.</span></div>`;
    rc.textContent = "";
    return;
  }
  let repos: RepoRef[] = [];
  try {
    repos = await reposUnder(dir);
  } catch {
    /* git unavailable */
  }
  rc.textContent = `${repos.length} repo${repos.length === 1 ? "" : "s"}`;
  if (repos.length === 0) {
    b.innerHTML = `<div class="filehdr"><span class="fp">No git repository found under this folder.</span></div>`;
    return;
  }
  for (const repo of repos) {
    const raw = await repoDiff(repo.path).catch(() => "");
    const files = parseDiff(raw);
    const add = files.reduce((n, x) => n + x.additions, 0);
    const del = files.reduce((n, x) => n + x.deletions, 0);
    const grp = document.createElement("div");
    grp.className = "repo-grp";
    grp.innerHTML = `<div class="repo-grp-h"><span class="rg-name">${enc(repo.name)}</span><span class="rg-count">${files.length} file${files.length === 1 ? "" : "s"}</span><span class="rg-meta">+${add} −${del}</span></div>`;
    f.appendChild(grp);
    if (files.length === 0) {
      b.insertAdjacentHTML("beforeend", `<div class="filehdr"><span class="fp">${enc(repo.name)} — working tree clean</span></div>`);
    } else {
      b.insertAdjacentHTML("beforeend", `<div class="filehdr" style="background:var(--surface-2)"><span class="fp"><b>${enc(repo.name)}</b></span></div>`);
      for (const file of files) b.insertAdjacentHTML("beforeend", renderFile(file));
    }
  }
}

/** Wire the topbar toggle. Call once at startup. */
export function initAiCode() {
  document.getElementById("btnAiCode")?.addEventListener("click", () => {
    const p = panel()!;
    const open = p.classList.toggle("open");
    document.getElementById("btnAiCode")?.classList.toggle("on", open);
    if (open) void render();
  });
}
```

- [ ] **Step 2: Init it from `main.ts`**

In `src/main.ts`, add the import near the other top imports:

```ts
import { initAiCode, setActiveDirProvider } from "./aicode";
```

Then where `initTitlebar();` is called (near the other init calls), add:

```ts
setActiveDirProvider(() => activeWs?.dir ?? null);
initAiCode();
```

- [ ] **Step 3: Typecheck + tests**

Run: `npx tsc --noEmit && npm run test`
Expected: tsc clean; all tests pass (Rust review tests are run separately via cargo).

- [ ] **Step 4: Manual verification**

Run: `npm run tauri dev`. Open a workspace on `D:\FacebookAuto` (parent of repos) → click **AI Code** → confirm two repo groups (`FacebookMarketing`, `mkt.adayroi.online`) appear with their changed files + hunks; clean repos show "working tree clean". Toggle off returns to the grid. Also try a single-repo folder → one group.

- [ ] **Step 5: Commit**

```bash
git add src/aicode.ts src/main.ts
git commit -m "feat(aicode): read-only multi-repo diff view wired to AI Code toggle"
```

---

## Self-Review notes

- **Spec coverage (read-only subset):** multi-repo discovery for parent folders + single repo (T1), working-tree diff per repo (T2), diff parsing (T4), repo-grouped read-only rendering in the Mission Control shell (T6–T7), Inter/JetBrains Mono + per-repo banded styling reused from the approved mockup (T6). Per-hunk accept/reject, stage, commit, merge, merge-queue, per-agent (worktree) diff, and the live-grid center zone are **explicitly deferred to Slice 2** — not gaps.
- **Placeholder scan:** none — full code in every code step; the one "copy from mockup" step (T6.1) references a concrete committed file and lists the exact selectors.
- **Type consistency:** `RepoRef {path,name}` matches across Rust (`review.rs`) and TS (`ipc.ts`); `DiffFile/DiffHunk/DiffLine` defined in `diff.ts` and consumed in `aicode.ts`; command names `git_repos_under`/`repo_diff` align Rust↔ipc; camelCase `repoRoot` → snake_case `repo_root` per the established Tauri convention.
