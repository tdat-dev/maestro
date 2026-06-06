# AI Code — Diff Review — Design (Phase B)

**Date:** 2026-06-06
**Status:** Approved (design)
**Milestone:** M2 (orchestration — Diff/Merge Review, §8/§15/§16)
**Depends on:** Phase A — Git Worktree Isolation (per-agent branch/worktree).
**Chosen direction:** opt5 "Mission Control" (refined). Mockup:
`design/diff-mockups/opt5-mission-control/index.html` (+ alternatives opt1–4 in
the same folder).

## Summary

A first-class "AI Code" view: review each agent's git changes (from its isolated
worktree/branch) while the fleet keeps running. Three zones — Fleet rail
(agents grouped by repo) · live terminal grid (center, agents stay alive) ·
Review dock (right): per-file/per-hunk **accept/reject**, stage, commit on the
agent's branch, then **merge → base**, with a **merge queue** for many agents.
Multi-repo parent workspaces group everything by sub-repo.

## Decisions (from brainstorming + 5-way design exploration)

- **Layout:** Mission Control — review beside the live grid (not a takeover
  modal). A top-bar **"AI Code"** toggle re-lays `.main` into the three zones.
- **Per-agent diff:** each agent's branch vs the base it forked from (Phase A).
- **Control depth:** view + **per-hunk accept/reject** + stage + commit + merge.
- **Merge queue:** per-agent merge can enqueue; the queue drains with status
  (queued / merging / blocked / done).
- **Repo division is first-class:** fleet rail + dock + queue group by repo,
  each repo a banded section with its own accent colour + agent count. Single
  git repo → per-agent worktrees in one group; parent-of-repos → one group per
  scanned sub-repo.
- **Typography (cross-cutting):** adopt **Inter** (UI) + **JetBrains Mono**
  (code), replacing Geist / Bricolage Grotesque / IBM Plex Mono app-wide — the
  current fonts read as jagged at small sizes. Applied in the mockup; rolled
  into `tokens.css` during implementation.

## Components

### Rust — `gitdiff` / `review` module + commands

- `git_repos_under(dir) -> Vec<String>` — the single repo root if `dir` is a
  repo, else immediate sub-folders that are git repos (multi-repo parent scan).
- `agent_diff(worktree, base) -> DiffFile[]` — `git -C <worktree> diff <base>`
  parsed into `{ path, status, additions, deletions, hunks: [{ header, oldStart,
  newStart, lines: [{ kind: ctx|add|del, text }] }] }`. JSON to the frontend.
- `apply_hunks(repo, accepted_hunk_patches) -> ()` — build a patch from the
  accepted hunks and `git -C <repo> apply --cached --recount` (partial staging,
  `git add -p` semantics).
- `commit(repo, message) -> ()` — `git -C <repo> commit -m <message>` (staged).
- `merge_branch(repoRoot, branch, base, cleanup) -> MergeResult` — `git checkout
  base; git merge <branch>`; on success and `cleanup`, run Phase A's
  `worktree_remove` + delete branch. Conflicts return a structured failure
  (conflict-resolution UI is out of scope for v1 — surface, don't resolve).
- All via `std::process::Command` (system git), registered in `invoke_handler`.

### Frontend — `aicode.ts` module + UI

- **View toggle:** "AI Code" button in the topbar flips `.main` between the
  pane grid and the Mission Control layout (`grid-template-columns: fleet /
  grid / dock`). Agents keep running; the reviewed agent's pane gets a lime
  `reviewing` ring.
- **Fleet rail:** agents grouped by repo (from Phase A `workspace.repoRoot` +
  per-agent `branch`), each with live status pip + `+/-` counts; repo section
  headers with per-repo accent colour + agent-count chip.
- **Review dock:** for the selected agent, fetch `agent_diff`, render
  files → hunks; per-hunk Accept/Reject (+ per-file); editable commit message;
  Stage / Commit / **Merge → base**; collapsible **merge queue**; a
  verification-gate chip (see Scope).
- **Multi-repo:** dock + queue also grouped by sub-repo.
- Reuses Phase A data (`pane.spec.worktree`, `branch`, `workspace.repoRoot`)
  and existing components (topbar, panes, `.btn`/`.btn-ghost`, pips, scrollbars).

## Data Flow

```
AI Code toggle -> Mission Control layout
select agent (lane or pane) -> agent_diff(worktree, base) -> render files/hunks
accept/reject per hunk -> client tracks accepted set
Stage  -> apply_hunks(repo, acceptedPatches)
Commit -> commit(repo, message)
Merge  -> enqueue OR merge_branch(repoRoot, branch, base, cleanup)
queue drains -> per-item status; blocked if verification fails
multi-repo parent -> git_repos_under(dir) -> per-repo groups + diffs
```

## Error Handling

- No changes / clean worktree → dock shows an empty "working tree clean" state.
- Non-git / no worktree (isolation was off) → "AI Code" falls back to a
  workspace-level diff of the dir (still per-hunk), no per-agent attribution.
- `apply_hunks` failure (overlapping/dependent hunks) → report which hunk
  failed; leave the index unchanged.
- `merge_branch` conflict → surfaced as a blocked queue item with the conflicting
  files listed; resolution is manual (open the worktree) for v1.
- Browser preview (no Tauri) → view renders with mock data, git calls no-op.

## Testing

- **Unit:** `aicode.test.ts` — unified-diff parser (`parseDiff`) over sample
  patches (adds/dels/context, multiple hunks, new/deleted files); accepted-hunk
  → patch builder; repo-grouping of agents.
- **Manual / integration:** spawn an isolated crew, let agents edit, open AI
  Code → review per-hunk, stage/commit, merge one branch (worktree cleaned),
  and the multi-repo parent case.

## Out of Scope (YAGNI / later)

- **Conflict-resolution UI** — v1 surfaces conflicts and points to the worktree;
  no in-app 3-way merge.
- **Real verification runner** — the gate chip is shown; actually running
  tests/lint per worktree and gating merge on the result is a follow-up
  (needs a per-repo test command config).
- Syntax highlighting + intra-line word diff — nice-to-have polish, not required
  for the first cut (faux-tokenisation acceptable initially).
- Keyboard-first command palette (borrowed from opt2) — optional enhancement.
- Diff virtualization for very large files — add when profiling shows need.
