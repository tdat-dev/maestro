# Maestro Orchestrator

Standalone Python loop: **Scout → Builder → Reviewer** over your installed
AI CLIs (`claude`, `codex`, `gemini`). Runs tests in an isolated git
worktree, captures errors from stderr (+ optional Sentry), and repeats
until tests pass and the Reviewer approves.

## Install

    python -m pip install -e ".[dev]"

## Run

    python -m orchestrator run --repo PATH --goal "add a /health endpoint with a test"

Options: `--config cfg.yaml`, `--max-iters N`, `--branch NAME`.

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
