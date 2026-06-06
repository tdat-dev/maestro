# Git Worktree Isolation — Design (Phase A of "AI Code")

**Date:** 2026-06-06
**Status:** Approved (design)
**Milestone:** M1 (multi-agent dashboard)
**Why now:** prerequisite for per-agent diff review ("AI Code", Phase B) — without
per-agent isolation the filesystem can't attribute changes to an agent.

## Summary

When a workspace points at a single git repo, run each agent in its own
`git worktree` on its own branch (off current HEAD), so each agent's changes are
isolated and individually reviewable/mergeable later. Auto-enabled for git
repos (toggle in the spawn modal). Parent-of-many-repos and non-git workspaces
fall back to the shared directory.

## Decisions (from brainstorming)

- **Auto-enable for git-repo workspaces**, with a spawn-modal toggle (default ON
  when the picked dir is a git repo).
- **Worktree location:** same drive as the repo, hidden root —
  `<drive>:\.maestro-worktrees\<repo-slug>\<branch>` (e.g. `D:\.maestro-worktrees\...`).
  Keeps off C: (`%LOCALAPPDATA%`) and out of the project tree.
- **Multi-repo parent workspace** (dir itself is not a repo but contains repos):
  no per-agent worktree; Phase B scans and shows each sub-repo's diff.
- **Non-git workspace:** no isolation; shared directory (current behaviour).
- **Lifecycle:** worktrees persist after a pane closes (they hold un-reviewed
  work); cleanup is explicit (Phase B merge/discard), not on pane kill.

## Components

### Rust — `worktree` module + commands

- `git_repo_root(dir) -> Option<String>` — `git -C <dir> rev-parse --show-toplevel`;
  `Some(root)` means a single-repo context (isolate), `None` means not a repo
  (parent-of-repos or plain folder → no isolation).
- `worktree_add(repo_root, branch) -> String` — compute the path per the rule
  above, then `git -C <repo_root> worktree add -b <branch> <path> HEAD`; return
  the worktree path.
- `worktree_remove(repo_root, path, delete_branch)` —
  `git -C <repo_root> worktree remove --force <path>` and, if requested,
  `git -C <repo_root> branch -D <branch>`.
- Git is invoked via `std::process::Command` (system git). If git is missing,
  commands return an error the frontend treats as "isolation unavailable".
- Registered in the existing `invoke_handler`.

### Frontend

- **Detection:** when a workspace is created with a `dir`, call `git_repo_root`.
  Store `repoRoot` and an `isolated` flag on the `Workspace`. The spawn modal
  shows an **"Isolate each agent in its own git worktree"** toggle only when the
  dir is a single git repo; default ON.
- **Per-agent boot:** if the workspace is isolated, before booting an agent call
  `worktree_add(repoRoot, branch)` → set the agent's effective `cwd` to the
  returned worktree path (overriding `spec.cwd`) → boot there. Persist
  `worktree` and `branch` on the pane/spec for Phase B and cleanup.
- **Branch name:** `maestro/<agent-slug>-<shortId>` (slug from the agent name).
- **Indicator:** a small branch badge on the pane (and/or tab) showing the
  agent's branch, so isolation is visible.

### Data model

- `AgentSpec`: add optional `worktree?: string`, `branch?: string`.
- `Workspace`: add `repoRoot?: string`, `isolated: boolean`.

## Data Flow

```
createWorkspace(dir) -> git_repo_root(dir)
  Some(root) -> workspace.repoRoot=root; show isolation toggle (default ON)
  None       -> no isolation (multi-repo parent / non-git)

spawn (isolated): for each agent before boot
  worktree_add(repoRoot, "maestro/<slug>-<id>") -> path
  agent.cwd = path ; spawnPty(... path ...)
  persist {worktree: path, branch} on pane/spec

pane close -> keep worktree (work preserved)
explicit cleanup (Phase B) -> worktree_remove(...)
```

## Error Handling

- Non-git dir → `git_repo_root` returns `None` → silent fallback to shared dir.
- `worktree_add` fails for an agent → that agent falls back to the workspace dir
  and a warning is written to its pane; other agents proceed.
- Git not installed → isolation toggle disabled + a one-time notice.
- Browser preview (no Tauri) → no isolation; spawning works against the dir.

## Testing

- **Unit:** `worktree.test.ts` — `worktreePathFor(repoRoot, branch)` (drive
  derivation, slug, hidden root), `branchName(agentName, id)` (slugging,
  collision-resistant suffix).
- **Manual / integration:** spawn a crew into a git repo → confirm each agent
  gets a worktree + branch under `<drive>:\.maestro-worktrees\...`, edits are
  isolated, `git worktree list` shows them, and they survive pane close.

## Out of Scope (YAGNI — handled in Phase B or later)

- Reading/showing diffs and merging (Phase B — "AI Code" diff review).
- Per-(agent × sub-repo) worktrees for multi-repo parents.
- Automatic worktree garbage collection / orphan reaping.
- Reusing a prior worktree when resuming a restored (stopped) pane — restored
  agents create a fresh worktree on resume.
- Conflict resolution UI.
