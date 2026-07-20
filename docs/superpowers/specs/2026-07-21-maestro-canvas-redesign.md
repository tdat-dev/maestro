# Maestro canvas redesign — design

Date: 2026-07-21 · Status: approved · Branch: `feat/maestro-mcp`

## Goal

Replace the rigid **tiling grid** of agent panes with a **canvas of named
agent "clouds"** that is calmer to look at and satisfying to arrange, while
keeping terminals fully usable. Two states per project tab:

- **Overview** — agent clouds float on a deep canvas: name, CLI colour,
  status, a dimmed live tail, token/cost. Drag to arrange; positions persist.
  Fixes today's cramped grid ("rối mắt" when many agents run).
- **Focus** — click a cloud → it FLIP-zooms into a full stage terminal you can
  type in; the other clouds slide into a **right-edge cloud rail** (instead of
  being hidden as they are today). Click a rail cloud to swap; Esc → overview.

Layered on top: every agent has an **editable name**, the broadcast bar
becomes an **`@name` command bar**, and **agent→agent delegation** (already
possible via maestro-mcp) is **drawn on the canvas** as a transient connector.

The whole app is unified under one **visual token system** so Home, wizard,
settings, modals, the tools dock and the code panel share the canvas language.

Delivered in **3 phases**, each with its own implementation plan.

## What already exists (reused, not rebuilt)

- `main.ts`: `Workspace` = a tab owning `gridEl` (`.grid`) + `panes:
  Map<id, Pane>`. `Pane` has `id`, `name`, `spec`, `el`, `term`, `running`,
  `lastInputAt`. `relayout(ws)` tiles 1→full / 2→split / 4→2×2 via `--cols`
  / `--rows`. `toggleMax(ws, pane)` sets `.pane.maxed` + `.grid.has-max`
  (which today does `display:none` on the rest).
- `fleet.ts`: `paneStatus(pane)` → running/idle/attention state used by the
  Fleet panel and topbar counts.
- `crew.ts`: `CLI_PRESETS` (per-CLI id, label, colour, args) — source of each
  agent's CLI badge colour.
- Broadcast bar in `index.html` (`#bcast`): input + target picker
  (`#bcastTargets`) + send. Targeting hooks registered from `main.ts`.
- maestro-mcp: `fleet_send`, `agent_spawn`, conductor mode, board tools. The
  agent→agent handoff channel already exists — this redesign **visualises** it,
  it does not invent it.
- `MAESTRO_AGENT` env carries each pane's display name into the agent (from the
  Board⇄Agent phase) — the identity spine we extend.
- `panels.ts` pointer-events splitter pattern; the intro/home aurora + grid
  backdrop CSS — reused as the canvas backdrop.
- **No HTML5 drag** anywhere: WebView2 breaks it. All dragging is Pointer
  Events with `setPointerCapture`, matching `panels.ts`.

---

## Phase 1 — Canvas + focus + identity

### 1.1 Canvas layout model

New module `src/canvas.ts` (pure geometry + layout state, unit-testable) plus
wiring in `main.ts`. The `.grid` element becomes a `.canvas` element; panes
become **clouds** positioned on it.

- **Cloud position** per pane: `{ x, y }` in canvas coordinates, stored on the
  `Pane` and persisted per-workspace under `localStorage["maestro.canvas.<wsKey>"]`
  (keyed by workspace dir, like recents). New panes get an auto-slot from
  `nextSlot(existing): {x,y}` — a tidy flow layout (row-major, cloud-sized
  cells) so a fresh spawn never lands off-screen or on top of another.
- **Auto-arrange** action ("tidy") re-runs `nextSlot` for all clouds — the
  escape hatch when the canvas gets messy.
- `relayout()` is retired for the canvas; the grid tiling math (`gridDims`)
  stays only where the wizard preview still uses it.

### 1.2 Cloud (overview card)

Each cloud renders (built in `canvas.ts`, styled in `styles/canvas.css`):

- header: status pip (colour from `paneStatus`) · **name** · CLI badge (colour
  from `CLI_PRESETS`).
- body: **dimmed live tail** — the last ~3 lines of the pane's output, mono,
  low-contrast. Sourced from a lightweight ring buffer the pane already feeds
  xterm; we tap the same write path (no second PTY read).
- footer: token/cost mini (reuse the usage source) when present, else idle time.
- **states:** `live` = faint breathing glow in the agent's colour; `idle` =
  flat; `done`/exited = ✓ or dim. One motion language: transform-only, no
  `opacity:0` on the card itself.

Dragging a cloud (pointer events) updates `{x,y}` live and saves on pointerup.
Dragging empty canvas **pans** (translate the canvas layer).

### 1.3 Focus (zoom-in) ↔ overview

Reworks `toggleMax` into `focusPane(ws, pane)` / `exitFocus(ws)`:

- Entering focus: the picked cloud **FLIP-animates** from its canvas rect to the
  stage rect (measure first/last rect, animate the transform). Stage = the
  canvas area minus the right cloud rail. `pane.term.focus()` after the
  transition so typing works immediately.
- Other clouds slide into a **right cloud rail** (`.cloud-rail`) as compact
  thumbnails (pip + name + colour). This replaces today's `display:none`.
  Rail width reuses the `panels.ts` splitter pattern; persisted.
- Swap: clicking a rail cloud focuses it (FLIP from rail slot). Esc, or click
  the stage backdrop margin, calls `exitFocus` → FLIP back to canvas.
- Only one pane focused at a time (same invariant as `maxed` today). If the
  focused pane dies, fall back to overview (mirrors the existing
  "maxed pane gone" guard).

### 1.4 Identity: editable names

- **Auto-name on spawn:** `nameForNewPane(cli, taken): string` picks the next
  free persona from a curated pool (`PERSONA_NAMES` in `crew.ts` — short,
  neutral, e.g. Ana, Bob, Cid, Dot, Eve, Fin, Gio, Hux…), never colliding
  within a workspace. Falls back to `"<CLI> N"` if the pool is exhausted.
  This replaces the current `Claude Code #1` default as the *display* name.
- **Rename:** click the name on a cloud (or in focus header) → inline text
  input. On commit, update `pane.name`, persist under
  `localStorage["maestro.names.<wsKey>"]`, and **re-export `MAESTRO_AGENT`** to
  the running agent if the PTY supports a live env nudge; otherwise the new name
  applies to the next spawn/resume and everywhere in the UI immediately.
- Name is the single identity used by: cloud, rail, topbar counts, broadcast
  targets, board `assignee`, and delegation lines. Renames propagate to the
  board's existing `assignee` matching (name → pane).
- A per-agent **colour/avatar** derives deterministically from the name (hash →
  hue), layered over the CLI badge colour so two Claudes are still tellable
  apart.

### 1.5 Error handling (Phase 1)

- Corrupt/absent canvas-position store → fall back to `nextSlot` auto-layout;
  never crash the tab. Positions off the current viewport are pulled back into
  view by "tidy".
- Duplicate names after a rename → allowed but flagged (a subtle "2" affix in
  targeting only); the pane `id` remains the true key everywhere internal.
- Rail/stage split with 1 pane → no rail; focus == full stage.

---

## Phase 2 — Broadcast `@name` + delegation visualisation

### 2.1 `@name` command bar

Upgrades the existing `#bcast` input (logic in a new `src/mention.ts`, pure +
tested; wired where the broadcast send lives today):

- `parseMentions(text, agents): { targetId, body }[]` — splits an input into
  per-agent messages. `@Ana do X` → Ana's stdin. Multiple mentions in one
  submit fan out line-by-line. **No** `@` → current behaviour (whole fleet or
  the selected target set) is preserved exactly.
- Typing `@` opens an **autocomplete** of live agent names (same source as the
  target picker), keyboard-navigable, colour-dotted. Selecting inserts the name.
- Sends route through the existing per-pane sender hook (the one the board's
  "send to agent" uses), so submit/Enter semantics match today.

### 2.2 Delegation on the canvas

maestro-mcp `fleet_send` (and conductor assignments) already move work between
agents. We surface each hop:

- maestro-mcp emits a **delegation event** `{ from, to, summary, ts }` (it knows
  `MAESTRO_AGENT` = sender and the target) onto the same board/IPC channel the
  app already polls. No new socket — reuse the poll used for board changes.
- On the canvas: a **transient connector** is drawn from the `from` cloud to the
  `to` cloud (SVG overlay layer), with a travelling pulse in the accent gradient
  and a small `"Cid → Dot"` label, then fades (it is a signal, not permanent
  wiring). In focus mode it appears as a toast instead.
- The **Fleet panel** gains a scrollable **delegation feed** (who handed what to
  whom, newest first) — the durable record; canvas lines are the ambient view.

### 2.3 Error handling (Phase 2)

- `@name` with no live match → inline "no agent named X", nothing sent.
- Delegation event referencing an agent that has since exited → connector drawn
  to a ghost slot / skipped; the feed still logs it by name.
- Poll gap (app was backgrounded) → feed backfills from the board journal;
  canvas only animates events newer than the last render (no burst on resume).

---

## Phase 3 — Whole-app visual sync

Extract a **token layer** in `styles/tokens.css` (canvas material, accent
gradient stops, cloud elevation/shadow, radius scale, motion durations/easings)
and re-skin every surface against it:

- topbar / tabs, tools dock rail, code panel, broadcast bar — align to the
  cloud/canvas material and the single motion language.
- Home, wizard, settings, spawn modal, confirm, schedule, usage, replay,
  update toast — restyled to the same tokens. Behaviour unchanged; only the
  visual language moves. Keep Geist / Geist Mono; keep the lime→teal→green
  signature used with restraint (live states, focus aura, delegation flow).
- Anti-slop guardrails (per house rules): no generic template hero, no default
  fonts, restrained palette, transform-based entrances only (never `opacity:0`
  on a section — the intro/home already follows this).

Phase 3 is intentionally last: it depends on Phases 1–2 having settled the new
components, and it is the lowest-risk (visual-only) work.

---

## Testing

- **Unit (Phase 1):** `nextSlot` packing + collision-free; canvas-position
  persist/restore round-trip incl. corrupt store; `nameForNewPane` uniqueness +
  pool-exhaustion fallback; FLIP rect math helper.
- **Unit (Phase 2):** `parseMentions` (single/multi/no-mention/unknown-name);
  delegation-event dedup + "newer than last render" filter.
- **Manual (Phase 1):** spawn N agents → overview reads clean; drag + tidy;
  focus a cloud → others go to the rail, typing works; swap via rail; Esc back;
  rename → propagates to board assignee + broadcast targets; kill focused pane →
  graceful fallback.
- **Manual (Phase 2):** `@Ana …` routes correctly; autocomplete; agent-run
  `fleet_send` draws a connector + logs in the feed; focus-mode toast.
- **Manual (Phase 3):** every modal/screen renders under the new tokens in both
  the maximized and small window; no FOUC; screenshot-review each surface.

## Out of scope (explicitly not now)

- True infinite/continuous zoom (we ship the 2 discrete states + pan only).
- Splitting/pinning 2+ terminals side by side in focus (candidate follow-up).
- Multi-project single canvas (tabs stay; each tab = its own canvas).
- Cross-workspace delegation; new transport/WebSocket (poll stays).
- Changing agent spawning, PTY, tree-kill, or the board data model beyond the
  additive name/position/delegation-event fields.
