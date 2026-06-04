# Maestro — Multi-Agent CLI Orchestrator — Design Spec

- **Date:** 2026-06-04
- **Status:** Approved (design phase) — ready for implementation planning
- **Working name:** Maestro (renameable; only affects folder/package identity)
- **Target platform:** Windows 10/11 first (no WSL required), designed to remain portable to macOS/Linux later

---

## 1. Vision & Problem

Build a **native-Windows desktop app** that runs and orchestrates **many heterogeneous AI agent CLIs** at once (Claude Code, Codex, Gemini CLI, OpenCode, Amp, Cursor, Aider, and any user-installed CLI). Each agent runs isolated in its own git worktree, agents communicate through a central message bus, and one agent can be designated the **orchestrator ("lead")** that breaks work down and delegates it to the others. The app shows a dense grid of live terminal panes (hybrid: grid + dashboard) and provides a polished review/merge/template experience.

**Why this is an unfilled niche (grounded in research):** the "manage many agent CLIs in parallel" category is crowded but **Windows-hostile**. Nearly every existing tool (Claude Squad, uzi, agent-deck, agentmux, and Anthropic's official "agent teams" split-pane mode) hard-depends on **tmux**, which has no native Windows build → they only run under WSL2. Polished GUI apps are Mac-only (Conductor, Sculptor) or deprecated/sunsetting (Crystal→Nimbalyst, Vibe-Kanban, Terragon). Anthropic's first-party agent teams is experimental, **Claude-only**, and its visual split-pane mode is explicitly unsupported on Windows Terminal. The gap: a **native-Windows, multi-vendor, GUI orchestrator** with worktree isolation and a review/merge dashboard.

## 2. Goals / Non-Goals

**Goals**
- Native Windows (no WSL) desktop app; lightweight enough to run comfortably on 8GB RAM (target dev machine has 16GB / i7 12c / RTX 2070 8GB).
- CLI-agnostic: auto-detect installed CLIs; add any new CLI via declarative config (no code changes).
- Run many agents concurrently with a resource-adaptive governor.
- Hybrid UX: default view is a live tiled grid of terminal panes; dashboard/timeline/diff are companion views; open/focus a pane on demand.
- Pluggable orchestrator: any agent can be the "lead" that delegates via orchestration tools; a deterministic engine executes safely.
- Inter-agent communication via a central, logged mailbox.
- Templates (4 layers) saved/reusable/importable/exportable.
- Strong safety: git worktree isolation, approval gates, verification gates, cost/budget caps.

**Non-Goals (v1)**
- Peer-to-peer agent protocols (A2A) for *local* agents — overkill; reserved only for remote/external agents later.
- Cloud/SaaS hosting — this is a local desktop tool.
- Building our own coding agent — we orchestrate existing CLIs, not replace them.
- Pure-TUI rendering of full-screen child apps in Rust (research **refuted** `tui-term` readiness) — we use xterm.js.

## 3. Target Environment & Constraints

- Windows 10 1809+ (build 17763) required for ConPTY; Windows 11 has WebView2 preinstalled.
- Lightweight: app shell + dashboard target ~80–150MB. Real RAM cost is the agent processes themselves (Node-based agents ~150–400MB each).
- Concurrency: resource-adaptive governor; ~4–8 comfortable live agents on 16GB, more via queueing + headless (no-pane) background agents. On 8GB, governor caps live panes and pushes background agents headless.

## 4. Key Research Findings (grounding the design)

Verdicts from adversarial verification (13-agent research workflow, 2026-06-04):

- **You do NOT need to puppet CLIs through a PTY for orchestration** (supported). Every major CLI has a headless/JSON mode. → Separate a **headless control plane** (JSON/SDK) from a **PTY view plane** (xterm.js). Never parse orchestration results from the PTY stream — only from JSON or git diffs.
- **CLI interface matrix** (supported):
  - Claude Code: official **Agent SDK (Python/TS)** for reliable multi-turn + tool-approval; `-p --output-format json|stream-json` for one-shots. ⚠️ raw `--input-format stream-json` stdin protocol is **officially underspecified** — do not build on reverse-engineered NDJSON.
  - Codex: `codex exec --json` (one-shot) **or** `codex mcp-server` (run Codex itself as a stdio JSON-RPC MCP server) `codex()` / `codex-reply()`.
  - OpenCode: `opencode serve` — genuine long-lived HTTP server, OpenAPI 3.1, SSE at `/event`, official `@opencode-ai/sdk`. Cleanest daemon target.
  - Gemini / Cursor / Amp: `stream-json` JSONL. **Amp and Cursor deliberately emit Claude-Code-compatible stream-json → one adapter drives Claude + Amp + Cursor.**
  - Aider: `--message --yes-always`; **read results from git diffs** (no JSON event stream).
- **Tech stack** (supported): Tauri idles ~80MB on Windows vs Electron ~120–400MB. xterm.js (VS Code's terminal engine) removes the biggest risk (no need to reimplement VT/ANSI). Pure-Rust `ratatui+tui-term` path **refuted** as not ready for full-screen interactive children on Windows.
- **Windows PTY gotchas** (supported): bare process kill orphans grandchildren → **must use a Win32 Job Object** (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) to kill whole trees. ConPTY editorializes the byte stream (reorders/late-forwards OSC/DCS, synthesizes repaints on resize) → debounce resize ~200ms and treat PTY as view-only. The assumed `0x8 PASSTHROUGH` flag **does not exist** (refuted; 0x8 is `GLYPH_WIDTH_GRAPHEMES`).
- **WebGL pane scaling** (uncertain/contradicted): Chromium caps ~16 active WebGL contexts per renderer; a single Tauri webview terminal app was observed at ~900MB. → Use canvas/DOM renderer by default; enable WebGL only for focused/visible panes; virtualize off-screen panes; consider multiple webviews if profiling shows growth.
- **Multi-agent reliability** (supported): MAST found 41–86.7% failure rates; flat "bag-of-agents" amplifies errors vs a central coordinator; Anthropic's multi-agent system used ~15× tokens. → Mandatory guardrails: per-worker token/time budgets, a verification gate (tests/lint) before any merge, and a circuit-breaker orchestrator. Note: Claude Code `-p`/SDK usage on subscription draws a separate Agent SDK credit pool as of 2026-06-15.
- **Local LLM (RTX 2070, 8GB VRAM)** (uncertain): not a safe sole orchestrator/router. Tool-calling reliability is model-specific (Qwen3-8B good; Qwen2.5-7B weak), 32K context needs KV-cache quantization. Use via **Ollama (not vLLM on Turing)** only for cheap glue (classification/summarization/log-triage/handoff-packet building); keep the orchestrator brain in the cloud.

## 5. Locked Decisions

| Decision | Choice | Rationale |
|---|---|---|
| UI form | Lightweight desktop GUI (Tauri v2) + live terminal-pane grid | Light + Windows-reliable PTY + reuse xterm.js |
| Stack | Rust (backend) + TypeScript/web (frontend) in Tauri WebView2 | Research-recommended; lowest combined risk |
| PTY | `portable-pty` (wezterm) → ConPTY | Supported Windows path |
| Terminal render | xterm.js, canvas/DOM default, WebGL only for focused panes | Avoid WebGL context cap & RAM blowup |
| Interaction | Hybrid: default live grid + dashboard/timeline/diff; focus-mode | Per user |
| Agent breadth | Multi-vendor + auto-detect any installed CLI + declarative adapters | Per user; the differentiator |
| Orchestrator | Pluggable LLM "lead" on top of a deterministic engine that exposes orchestration tools | Per user + research guardrails |
| Isolation | git worktree per agent (default); Docker container optional later | Industry norm; lightweight |
| Concurrency | Resource-adaptive governor | Safe across 8–16GB |
| Platform | Windows-first; avoid hard lock-in to ease later macOS/Linux | Per user |
| Inter-agent comms | Central mailbox (SQLite), logged/replayable; no direct P2P sockets | Single trust boundary |

## 6. Architecture — Two Planes, One Trust Boundary

```
FRONTEND (WebView2, React/TS)
  Grid of xterm.js panes · Dashboard · Task DAG/Kanban · Timeline ·
  Inter-agent message feed · Diff/Merge review · Lead chat+tasks · Templates · Approvals
        ▲ Tauri IPC (JSON events)          ▲ byte-stream (only opened panes)
BACKEND RUST (Tauri core) = ORCHESTRATOR + MESSAGE BUS
  CONTROL PLANE (headless, trusted)        VIEW PLANE (display only)
    Orchestrator Engine (Task DAG)           PTY Manager (portable-pty/ConPTY)
    Adapter Layer (CLI-agnostic)             resize-debounce, view-only
    Mailbox / Blackboard (SQLite)
  Supervisor + Win32 Job Object (tree-kill) · Resource Governor ·
  Worktree Mgr · Secrets Vault · Cost/Budget · Persistence · Notifier
        ▼            ▼             ▼              ▼
   Claude(SDK)  Codex(exec/mcp) OpenCode(serve) Aider(oneshot→git diff) … user-added
   (each agent runs inside its own git worktree)
```

**Invariant:** orchestration results are read only from the control plane (JSON/SDK) or git diffs — **never** screen-scraped from the PTY.

## 7. Backend Modules (Rust)

Each module is independently testable with a clear interface.

| Module | Responsibility | Depends on |
|---|---|---|
| `supervisor` | spawn/stop/restart agents; **Win32 Job Object** tree-kill; crash recovery | OS |
| `governor` | cap live agents by free RAM/CPU; queue overflow | supervisor |
| `adapters` | CLI-agnostic abstraction (see §9) | — |
| `detector` | scan PATH/npm-global; probe `--version`/`--help`; map to adapter presets | adapters |
| `pty` | `portable-pty`→ConPTY; stream bytes to frontend; debounce resize ~200ms | supervisor |
| `orchestrator` | deterministic scheduler; Task DAG; capability-based assignment; budgets; circuit-breaker; exposes lead tools (§10) | mailbox, adapters |
| `mailbox` | inter-agent messages (SQLite); blackboard/shared context; handoff packets | db |
| `worktree` | git worktree/branch per agent; conflict surfacing | git |
| `secrets` | central key vault (OS keyring); inject per adapter; redact logs | OS keyring |
| `cost` | token + $ per agent/session; caps that pause | db |
| `persistence` | sessions; append-only event log; checkpoints; resume | SQLite |
| `notifier` | desktop/sound; Telegram later | — |

## 8. Frontend Modules (React/TS in WebView2)

- **Mission Control**: overview of agents, status, Task DAG/Kanban, resource & cost meters.
- **Pane Grid**: tiled live xterm.js panes (configurable rows/cols), title bar + controls per pane, focus-mode (expand one full-screen), lazy render, WebGL only on focused pane, virtualize off-screen.
- **Lead Panel** (right dock): chat with the designated lead agent + live Tasks list (the shared task list states/checkboxes).
- **Unified Timeline**: single filterable feed across all agents; includes the **inter-agent message feed** (transparency).
- **Diff/Merge Review**: per-agent diffs, accept/reject per hunk, merge worktrees.
- **Template Manager**: browse/create/edit/import/export the 4 template types.
- **Approval Gates**: pause/approve dangerous actions (git push, deletes, system commands).
- **Settings**: adapters, secrets, budgets, governor, local model.

## 9. Adapter System — the CLI-Agnostic Backbone

Each CLI is described by a declarative config (TOML) selecting a **driver kind**. Adding a CLI = adding a config file (no code).

| Driver kind | Used for | Mechanism |
|---|---|---|
| `stream-json` | **Claude, Amp, Cursor** (one adapter for all three) | JSONL event stream |
| `codex` | Codex | `exec --json` and/or `mcp-server` |
| `http-server` | OpenCode | `serve` + SDK/SSE |
| `oneshot-diff` | Aider | `--message --yes-always` → parse git diff |
| `generic-pty` | unknown CLI without headless mode | puppet the interactive TUI via PTY (fallback) |

**Adapter config declares:** detect command/binary names, launch args (one-shot, multi-turn, server), capability probe, how to send a prompt, how to parse events/results, how to detect "waiting for input", headless flags, auth/env requirements.

**Built-in presets:** Claude Code, Codex, Gemini, OpenCode, Amp, Cursor, Aider. User adapters live alongside as editable/exportable files.

## 10. Orchestrator Engine & Lead Tools

The deterministic engine owns the Task DAG and exposes a set of **orchestration tools** to whichever agent is designated the lead (via function-calling / MCP). The lead is the "brain"; the engine executes safely (budgets, approval gates, logging, circuit-breaker).

Lead tools (initial set): `spawn_agent(adapter, role)`, `submit_prompt(agent, text)`, `broadcast(text)`, `create_task(...)`, `assign_task(task, agent)`, `read_summary(agent)`, `request_review(from, to)`, `run_verification(agent)`, `merge(worktree)`, `pause(agent)`, `stop(agent)`.

Guardrails: per-worker token/time budgets; verification gate (tests/lint must pass) before any merge; circuit-breaker that synthesizes rather than blindly fanning out.

## 11. Inter-Agent Communication

All messages flow through the orchestrator's **mailbox** (SQLite-backed): addressed agent-to-agent or agent-to-lead, fully logged → free logging, replay, budgets, timeouts. A **blackboard** (shared context files + index) lets agents read common decisions/files instead of re-discovering. **Handoff packets**: when delegating, the orchestrator builds a compact context packet (relevant files + task + constraints) instead of dumping everything. No worker opens direct sockets to another worker. A2A/Agent-Card reserved for remote/external agents only.

## 12. Isolation

Default: **git worktree per agent** (lightweight, shared dependencies; conflicts surface only at merge, reviewed in the dashboard). Optional **Docker container** isolation later for untrusted or dependency-divergent work (requires Docker Desktop).

## 13. Template System (4 layers)

All saved as files (versionable, exportable; YAML/TOML/MD), with built-in presets, user-create/edit, and import/export.
- **Team/crew preset**: agents + which is lead + roles + per-agent system prompts + pane layout.
- **Workflow**: orchestrator task-flow (e.g., analyze → code → review → test).
- **Adapter**: per-CLI config (see §9).
- **Prompt library**: reusable prompts attachable to any agent.

Storage: `templates/teams/*.yaml`, `templates/workflows/*.yaml`, `templates/adapters/*.toml`, `templates/prompts/*.md`.

## 14. Data Model (SQLite + files)

- `agents` — instance: adapter, worktree, status, pid, job handle, budget.
- `tasks` — DAG: id, parent, deps, assignee, state, DoD checklist, artifacts.
- `messages` — mailbox: from, to, body, ts.
- `sessions` — project, template, timeline ref.
- `events` — append-only timeline/audit log (enables replay).
- `costs` — per agent/session token + $.
- Templates and blackboard context stored as files (see §13, §11).

## 15. Key Flows

1. **Startup** → detect CLIs → health-check → load templates.
2. **Spin up team from template** → create agents (worktrees) → designate lead → arrange panes.
3. **Orchestration loop** → lead proposes Task DAG → *dry-run + cost estimate → user approval* → engine assigns tasks headlessly → workers run in worktrees → post results/messages to mailbox → **verification gate (tests/lint)** → diff review → merge.
4. **On-demand terminal** → user opens a pane → PTY attaches to that agent's interactive session.
5. **Inter-agent message** → worker posts to mailbox (addressed) → engine routes + logs.
6. **Budget/governor** → governor throttles concurrency; budget caps pause agents.

## 16. UI/UX Layout (reference: dense live grid + right lead/tasks dock)

Default screen = tiled grid of live panes (configurable count), each with a title bar + maximize/close + focus-mode; a right dock holds the **lead chat** (you ↔ lead; the lead issues orchestration tool calls like spawn/submit_prompt) and a **Tasks** list. Dashboard, timeline, and diff/merge are companion tabs/views.

## 17. Performance & Resource Governance

- Governor caps simultaneous live agents based on free RAM/CPU; overflow is queued; background agents can run headless (no pane) to save RAM.
- Terminal rendering: canvas/DOM default; WebGL reserved for focused panes (Chromium ~16 WebGL context cap); virtualize/suspend off-screen panes; profile single-webview RAM early and consider multiple webviews if it grows.
- ~12 concurrent Node agents ≈ 2.4–4.8GB just for agents → feasible on 16GB with the above; 8GB relies on governor caps + headless background.

## 18. Windows-Specific Concerns

- **Process-tree termination**: every spawned agent assigned to a Win32 Job Object (`KILL_ON_JOB_CLOSE`); also `ClosePseudoConsole` / `taskkill /T /F` as needed. (Load-bearing reliability gotcha.)
- **ConPTY**: debounce resize ~200ms; treat as view-only; no reliance on a non-existent passthrough flag.
- **WebView2 runtime**: preinstalled on Win11; bootstrapped on Win10; offline installs add ~127–180MB to bundle (distribution decision: prefer online bootstrapper installer).

## 19. Security

- Central secrets vault (OS keyring) injects keys per adapter; redact secrets from logs/transcripts.
- Audit trail of commands/files per agent (from the append-only event log).
- Optional per-agent permission profiles and FS/network sandboxing (later).

## 20. Local LLM Role (RTX 2070)

Optional, opt-in. Use Ollama for cheap "glue": task classification/routing hints, summarizing long agent output to fit context, log triage, building handoff packets. Not the sole orchestrator/router. Validate any cost-savings empirically. Suggested models that fit ~8GB: small quantized coder/instruct models (e.g., Qwen3-8B-class) with KV-cache quantization for longer context.

## 21. Feature Universe (full catalog from brainstorming)

The complete idea set, to be phased (see §22). Tags: 🟢 core · 🟡 later · 🔵 differentiator.

- **Orchestration**: 🟢 Task DAG + Kanban; 🟢 human-in-the-loop approval gates; 🟡 capability-based assignment; 🔵 best-of-N across vendors; 🔵 cross-vendor review; 🔵 debate mode; 🔵 speculative execution (race approaches on worktrees, kill losers); 🔵 self-healing test loop; 🟡 recursive decomposition (worker becomes sub-orchestrator); 🟡 map-reduce over codebase.
- **Quality/verification**: 🟢 local CI-in-the-loop (test/lint gate); 🟢 Definition-of-Done per task + verifier; 🟡 spec-driven.
- **Isolation/safety**: 🟢 git worktree per agent; 🟢 cost & token budget tracking + caps; 🟡 per-agent permission profiles; 🔵 FS/network sandbox.
- **Context/memory**: 🟢 shared blackboard; 🟢 handoff packets; 🟢 session persistence + resume; 🟢 auto-maintain project memory (CLAUDE.md/AGENTS.md); 🔵 lessons-learned store; 🔵 per-CLI performance analytics; 🟡 recipe capture.
- **Observability/UX**: 🟢 unified timeline; 🔵 inter-agent message feed (transparency); 🟢 diff viewer + per-hunk accept/reject; 🟢 notifications (desktop/sound/Telegram); 🟡 auto stand-up summaries; 🔵 live communication graph; 🔵 decision log ("why"); 🟡 codebase activity heatmap; 🟢 focus-mode; 🔵 inline annotations for an agent.
- **Steering**: 🟢 interrupt & redirect mid-task; 🟢 broadcast; 🔵 NL control of orchestrator; 🔵 voice push-to-talk; 🔵 Telegram remote control.
- **Automation/scheduling**: 🟡 cron template runs; 🔵 event triggers (file change / git push / issue); 🟢 task queue.
- **Resource mgmt**: 🟢 concurrency governor; 🟢 resource monitor; 🟢 lazy pane render; 🟡 idle suspension.
- **Cost optimization**: 🔵 smart model routing; 🔵 token-diet (local model compresses context); 🟡 budget-aware scheduling.
- **Output/onboarding**: 🟢 artifact collector; 🔵 auto-PR; 🟢 end-of-run report; 🟢 first-run wizard; 🟢 health-check dashboard; 🔵 community template/adapter sharing.
- **Reliability**: 🟢 per-agent checkpoint/resume; 🟡 auto-restart on crash + context replay; 🔵 deterministic replay + audit log.
- **Personas/advanced**: 🔵 persona/profile agents; 🔵 time-travel session checkpoints; 🔵 compare two runs; 🔵 dry-run simulation + cost/time estimate; 🟢 file-conflict resolver; 🟡 steering macros; 🟡 quality scoreboard; 🟡 headless orchestrator (CLI/CI mode); 🔵 expose orchestrator as MCP server.

## 22. Roadmap / Milestones

- **M0 — Skateboard** (prove the hard parts): Tauri shell + spawn one agent + live xterm.js pane via ConPTY + clean process-tree kill via Job Object.
- **M1 — Multi-agent dashboard** (core): CLI detector + adapter layer (`stream-json`, `codex`, `http-server`); spawn many agents + pane grid + dashboard + resource governor; git worktree isolation; secrets vault.
- **M2 — Orchestration** (differentiator): orchestrator engine (Task DAG/Kanban + pluggable lead + lead tools); mailbox + transparency feed; approval gate + verification gate + diff/merge review; cost/budget; shared context + handoff packets; persistence + resume.
- **M3 — Templates & polish**: 4-layer templates + presets + import/export; first-run wizard + health dashboard; notifications.
- **v1.5 — differentiators** 🔵: best-of-N across vendors; cross-vendor review; local Ollama glue (router/summarizer); self-healing test loop; voice; Telegram remote control.
- **v2 — advanced**: debate mode; speculative execution; scheduling/triggers; headless orchestrator (CLI/CI); MCP server exposure; time-travel; communication graph; dry-run simulation; persona profiles; lessons-learned/perf analytics; container isolation; sandbox.

## 23. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Category churn / vendor absorption | Differentiate on native-Windows + multi-vendor + GUI review/merge; keep adapters config-driven |
| Windows process-tree leak (burns tokens) | Win32 Job Object `KILL_ON_JOB_CLOSE` from M0 |
| ConPTY stream artifacts | resize debounce; PTY view-only; results from JSON/git only |
| Multi-agent unreliability & cost | budgets, verification gate, circuit-breaker, dry-run + cost estimate |
| Claude raw stdin protocol underspecified | use official Agent SDK, not reverse-engineered NDJSON |
| WebGL pane scaling / webview RAM | canvas default, WebGL focused-only, virtualize, profile early |
| Local 8GB LLM unreliability | opt-in glue only; cloud brain; validate economics |
| Dual-language velocity | clear module boundaries; thin IPC contract |

## 24. Open Questions / Future Decisions

- Distribution: online bootstrapper installer (small) vs offline bundle (+~127–180MB WebView2). Default: online.
- Exact local model + quantization to recommend (validate empirically in v1.5).
- Whether to wrap Anthropic's official agent-teams in-process mode as an optional component.
- Concurrency hard limits per machine class (tune from real profiling).
