# Maestro Orchestrator

Standalone Python loop: **Scout → Builder → Reviewer** over your installed
AI CLIs (`claude`, `codex`, `gemini`). Runs tests in an isolated git
worktree, captures errors from stderr (+ optional Sentry), and repeats
until tests pass and the Reviewer approves.

## Install

For development, inside this repo:

    python -m pip install -e ".[dev]"

To use it on **any repo from anywhere**, install it as a global tool (isolated
env, adds an `orchestrator` command to PATH):

    uv tool install <path-to-this-repo>      # or: pipx install <path-to-this-repo>

Then run it from any directory and point `--repo` at the target project:

    orchestrator run --repo C:\code\my-api --goal "add a /health endpoint with a test" --cli claude

`--repo` accepts any path:
- an existing **git repo** → the agents work in an isolated worktree off HEAD,
  so your working copy is never touched;
- a non-git folder with code → it is snapshotted first, then worked on in a
  worktree;
- an **empty folder** → a new project is scaffolded in place.

## Run

    python -m orchestrator run --repo PATH --goal "add a /health endpoint with a test"

With no `--config`, the roles default to Scout=`claude`, Builder=`codex`,
Reviewer=`gemini`. To run **all three roles on one CLI** without writing a
config file, use `--cli`:

    python -m orchestrator run --repo PATH --goal "..." --cli claude

`--cli claude|codex|gemini` points every role at that CLI with a sensible
headless template (the Builder gets write access automatically:
`claude -p --dangerously-skip-permissions`, `codex exec -s workspace-write`).
Any other name is treated as a bare executable. For finer per-role control,
use `--config` instead (below); `--cli` overrides whatever roles the config set.

Options: `--config cfg.yaml`, `--cli NAME`, `--max-iters N`, `--branch NAME`.

## Config (`cfg.yaml`)

    max_iterations: 6
    test_command: [python, -m, pytest, -q]   # omit to auto-detect
    agents:
      scout:    { args: [claude, -p] }
      builder:  { args: [codex, exec] }
      reviewer: { args: [gemini, -p] }
    sentry:
      enabled: false
      base_url: https://sentry.io/api/0
      token: ""
      org: ""
      project: ""

Each role maps to any CLI. Prompts go via stdin (`prompt_via: stdin`) by
default; use `prompt_via: arg` to pass the prompt as the final argument.

## Worktree lifecycle

The agent worktree is intentionally **not** auto-deleted after a run — the diff
it contains is the product of the agent's work and the user should be able to
inspect it. Re-running the orchestrator on the same repo/branch reuses and
resets the worktree. Call `teardown_worktree` explicitly if you want to discard
it. This diverges from the original spec's "always teardown in finally" on
purpose.

## Tests

    python -m pytest -q
