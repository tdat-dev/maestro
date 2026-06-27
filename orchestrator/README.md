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
      scout:    { args: [claude, -p, --dangerously-skip-permissions] }
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

## Tests

    python -m pytest -q
