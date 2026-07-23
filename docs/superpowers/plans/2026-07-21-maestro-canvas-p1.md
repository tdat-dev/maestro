# Maestro Canvas Redesign — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rigid tiling grid of agent panes with a draggable **canvas** where each pane has a title bar, a **Tidy** action tiles panes to fill the screen, clicking a pane **focuses** it (others collapse to a tiny avatar rail), and every agent has an editable **name**.

**Architecture:** Two pure, unit-tested modules — `src/canvas.ts` (layout geometry) and persona naming in `src/crew.ts` — drive DOM wiring in `src/main.ts`. The existing `Workspace.gridEl` keeps its element but switches from CSS grid tiling to absolute-positioned panes read from a per-workspace layout map. `toggleMax` is replaced by `focusPane`/`exitFocus` that push the other panes into a right-edge rail instead of hiding them. All dragging uses Pointer Events (WebView2 breaks HTML5 DnD).

**Tech Stack:** TypeScript, Vitest, Tauri v2 (WebView2), vanilla DOM + CSS, xterm.js.

## Global Constraints

- **No HTML5 drag-and-drop** anywhere — Pointer Events + `setPointerCapture` only (matches `src/panels.ts`). WebView2 breaks native DnD.
- **Never gate content visibility on a class-triggered entrance** — entrances translate/scale an already-visible element (existing `paneIn` keyframe pattern). No `opacity:0` on a pane that stays if a trigger misfires.
- **Dark-only**; keep Geist / Geist Mono; accent gradient `#c6f135 → #27b9a3 → #0f7a3e` used with restraint.
- Tokens come from `src/styles/tokens.css` (`--bg #090a0c`, `--run #34d399`, `--accent #c6f135`, `--surface-*`, `--text*`, `--muted*`, `--line*`). No new one-off colors.
- Tests are Vitest: `import { describe, it, expect } from "vitest"`, run with `npm test`. Pure functions live in the module they belong to and are imported by name (see `src/workspaces.test.ts`).
- Keep behavior of PTY spawn, tree-kill, status/attention, recording, and the remote dashboard snapshot **unchanged** — this phase only changes layout + identity, additively.

---

### Task 1: `src/canvas.ts` — layout geometry (pure)

**Files:**
- Create: `src/canvas.ts`
- Test: `src/canvas.test.ts`

**Interfaces:**
- Produces:
  - `type Pos = { x: number; y: number }`
  - `type Tile = { x: number; y: number; w: number; h: number }`
  - `type Area = { width: number; height: number }`
  - `type TileOpts = { gap?: number; margin?: number; top?: number; bottom?: number }`
  - `gridDimsFor(n: number): { cols: number; rows: number }`
  - `tileToFit(n: number, area: Area, opts?: TileOpts): Tile[]`
  - `nextSlot(existing: Pos[], cell: { w: number; h: number; gap?: number }, area: Area): Pos`
  - `serializeLayout(map: Record<string, Tile>): string`
  - `parseLayout(raw: string | null): Record<string, Tile>`

- [ ] **Step 1: Write the failing tests**

```ts
// src/canvas.test.ts
import { describe, it, expect } from "vitest";
import { gridDimsFor, tileToFit, nextSlot, serializeLayout, parseLayout } from "./canvas";

describe("gridDimsFor", () => {
  it("keeps 2 panes side by side, 4 in a 2x2", () => {
    expect(gridDimsFor(1)).toEqual({ cols: 1, rows: 1 });
    expect(gridDimsFor(2)).toEqual({ cols: 2, rows: 1 });
    expect(gridDimsFor(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridDimsFor(6)).toEqual({ cols: 3, rows: 2 });
  });
});

describe("tileToFit", () => {
  const area = { width: 1000, height: 800 };
  it("returns one tile per pane, none overlapping, all inside the area", () => {
    const tiles = tileToFit(4, area, { gap: 10, margin: 10, top: 10, bottom: 80 });
    expect(tiles).toHaveLength(4);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(10);
      expect(t.y).toBeGreaterThanOrEqual(10);
      expect(t.x + t.w).toBeLessThanOrEqual(area.width - 10 + 0.5);
      expect(t.y + t.h).toBeLessThanOrEqual(area.height - 80 + 0.5);
    }
  });
  it("stretches a lone last tile to fill the rest of its row", () => {
    const tiles = tileToFit(3, area, { gap: 10, margin: 10, top: 10, bottom: 10 });
    // 3 panes → cols 2 rows 2; last (index 2) is alone on row 2 and widens
    expect(tiles[2].w).toBeGreaterThan(tiles[0].w + 1);
  });
});

describe("nextSlot", () => {
  it("packs row-major and avoids an occupied first cell", () => {
    const area = { width: 1000, height: 800 };
    const cell = { w: 300, h: 200, gap: 12 };
    expect(nextSlot([], cell, area)).toEqual({ x: 0, y: 0 });
    const p2 = nextSlot([{ x: 0, y: 0 }], cell, area);
    expect(p2.x).toBe(312);
    expect(p2.y).toBe(0);
  });
});

describe("serializeLayout / parseLayout", () => {
  it("round-trips and tolerates a corrupt string", () => {
    const map = { a: { x: 1, y: 2, w: 3, h: 4 } };
    expect(parseLayout(serializeLayout(map))).toEqual(map);
    expect(parseLayout(null)).toEqual({});
    expect(parseLayout("{not json")).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/canvas.test.ts`
Expected: FAIL — "Cannot find module './canvas'".

- [ ] **Step 3: Write the implementation**

```ts
// src/canvas.ts
// Pure geometry for the pane canvas: grid-to-fit tiling, free-slot packing,
// and layout (de)serialization. No DOM — unit-tested in canvas.test.ts.

export type Pos = { x: number; y: number };
export type Tile = { x: number; y: number; w: number; h: number };
export type Area = { width: number; height: number };
export type TileOpts = { gap?: number; margin?: number; top?: number; bottom?: number };

/** Squarish grid: 2→2x1 (big side by side), 4→2x2, 6→3x2, … */
export function gridDimsFor(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  return { cols, rows };
}

/** Tile n panes to fill `area` (minus margins + a reserved bottom band for the
 *  command bar). A lone tile ending a short last row stretches to the right. */
export function tileToFit(n: number, area: Area, opts: TileOpts = {}): Tile[] {
  const gap = opts.gap ?? 12, mx = opts.margin ?? 18, top = opts.top ?? 16, bottom = opts.bottom ?? 84;
  const { cols, rows } = gridDimsFor(n);
  const tw = (area.width - 2 * mx - (cols - 1) * gap) / cols;
  const th = (area.height - top - bottom - (rows - 1) * gap) / rows;
  const out: Tile[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    const x = mx + c * (tw + gap), y = top + r * (th + gap);
    const inRow = Math.min(cols, n - r * cols);
    const w = i === n - 1 && inRow < cols ? area.width - mx - x : tw;
    out.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(th) });
  }
  return out;
}

/** First row-major grid position not colliding with `existing` top-lefts. */
export function nextSlot(existing: Pos[], cell: { w: number; h: number; gap?: number }, area: Area): Pos {
  const gap = cell.gap ?? 12;
  const stepX = cell.w + gap, stepY = cell.h + gap;
  const cols = Math.max(1, Math.floor((area.width + gap) / stepX));
  const taken = new Set(existing.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
  for (let i = 0; i < 4096; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    const x = c * stepX, y = r * stepY;
    if (!taken.has(`${x},${y}`)) return { x, y };
  }
  return { x: 0, y: 0 };
}

export function serializeLayout(map: Record<string, Tile>): string {
  return JSON.stringify(map);
}

export function parseLayout(raw: string | null): Record<string, Tile> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, Tile>) : {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/canvas.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/canvas.ts src/canvas.test.ts
git commit -m "feat(canvas): pure layout geometry — tileToFit, nextSlot, (de)serialize"
```

---

### Task 2: `src/crew.ts` — persona naming (pure)

**Files:**
- Modify: `src/crew.ts` (add exports; keep existing `CLI_PRESETS`, `expandCrew`, etc. untouched)
- Test: `src/crew.test.ts` (append a describe block)

**Interfaces:**
- Produces:
  - `PERSONA_NAMES: readonly string[]`
  - `nameForNewPane(cli: string, taken: string[]): string`

- [ ] **Step 1: Write the failing test** (append to `src/crew.test.ts`)

```ts
import { PERSONA_NAMES, nameForNewPane } from "./crew";

describe("nameForNewPane", () => {
  it("hands out the first free persona name", () => {
    expect(nameForNewPane("claude", [])).toBe(PERSONA_NAMES[0]);
    expect(nameForNewPane("claude", [PERSONA_NAMES[0]])).toBe(PERSONA_NAMES[1]);
  });
  it("falls back to '<CLI> N' when the pool is exhausted", () => {
    const taken = [...PERSONA_NAMES];
    expect(nameForNewPane("codex", taken)).toBe(`codex ${PERSONA_NAMES.length + 1}`);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/crew.test.ts`
Expected: FAIL — `nameForNewPane` not exported.

- [ ] **Step 3: Add the implementation to `src/crew.ts`**

```ts
// Short, neutral persona names given to panes on spawn; renameable in the UI.
export const PERSONA_NAMES = [
  "Ana", "Bob", "Cid", "Dot", "Eve", "Fin", "Gio", "Hux", "Ivy", "Jax",
  "Kim", "Lux", "Mei", "Nix", "Oz", "Pia", "Rue", "Sol", "Tao", "Uma",
] as const;

/** Next persona not already used in this workspace; else "<cli> N". */
export function nameForNewPane(cli: string, taken: string[]): string {
  const used = new Set(taken);
  for (const n of PERSONA_NAMES) if (!used.has(n)) return n;
  return `${cli} ${taken.length + 1}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- src/crew.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/crew.ts src/crew.test.ts
git commit -m "feat(crew): persona-name pool + nameForNewPane"
```

---

### Task 3: `src/styles/canvas.css` — pane, header bar, rail, focus, scrollbar

**Files:**
- Create: `src/styles/canvas.css`
- Modify: `src/styles/index.css` (add `@import "./canvas.css";` near the other imports)
- Modify: `src/styles/workspace.css` — remove the `.grid.has-max` display:none rules (Task 4 replaces them); leave the rest.

**Interfaces:**
- Produces CSS classes consumed by Tasks 3–5 DOM: `.canvas` (was `.grid`), `.pane` (glass), `.pane-bar` (drag handle: `.pb-dot .pb-name .pb-cli .pb-ctrls`), `.pane.focused`, `.cloud-rail` (`.rc` avatars), `.pane.stopped`, `.pane.run::before`.

- [ ] **Step 1: Write `src/styles/canvas.css`**

```css
/* Canvas: absolute-positioned panes over the ambient glow; a slim draggable
   title bar per pane; focus pushes the rest into a right-edge avatar rail. */
.grid.canvas{position:relative;display:block;background:transparent;gap:0}
.pane{position:absolute;border-radius:12px;overflow:hidden;
  box-shadow:0 22px 50px -22px rgba(0,0,0,.85),inset 0 1px 0 rgba(255,255,255,.03);
  transition:box-shadow .18s,border-color .18s}
.pane-bar{display:flex;align-items:center;gap:8px;height:32px;flex:none;padding:0 7px 0 11px;
  background:rgba(255,255,255,.025);border-bottom:1px solid var(--line);cursor:grab;user-select:none;touch-action:none}
.pane-bar:active,.pane.dragging .pane-bar{cursor:grabbing}
.pb-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--idle)}
.pane.run .pb-dot{background:var(--run);box-shadow:0 0 7px var(--run)}
.pb-name{font-size:12.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px}
.pb-name[contenteditable]{outline:none;border-bottom:1px dashed var(--accent-dim);cursor:text}
.pb-cli{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);
  padding:2px 6px;border:1px solid var(--line-strong);border-radius:5px;flex:none;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-sp{flex:1}
.pb-ctrls{display:flex;gap:1px;opacity:0;transition:opacity .12s}
.pane:hover .pb-ctrls,.pb-ctrls:focus-within{opacity:1}

/* focus: the focused pane fills a stage; others become a tiny avatar rail */
.grid.canvas.has-focus .pane{display:none}
.grid.canvas.has-focus .pane.focused{display:flex;left:0 !important;top:0 !important;
  width:calc(100% - var(--rail-w,74px)) !important;height:100% !important}
.cloud-rail{position:absolute;top:0;right:0;bottom:0;width:var(--rail-w,74px);z-index:8;
  display:flex;flex-direction:column;align-items:center;gap:10px;overflow-y:auto;padding:12px 8px}
.grid.canvas:not(.has-focus) .cloud-rail{display:none}
.rc{display:flex;flex-direction:column;align-items:center;gap:4px;padding:5px 2px;border-radius:12px;cursor:pointer;width:100%}
.rc:hover{background:var(--surface-1)}
.rc .av{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;font-size:12px;font-weight:800;color:#0a0d07;position:relative;box-shadow:0 0 0 2px var(--bg)}
.rc .av .s{position:absolute;right:-2px;bottom:-2px;width:11px;height:11px;border-radius:50%;border:2px solid var(--surface-0)}
.rc .n{font-size:9.5px;font-weight:600;color:var(--muted);max-width:66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* scrollbars: slim, hidden until the area is scrolled/hovered */
*{scrollbar-width:thin;scrollbar-color:transparent transparent}
*:hover,*.scrolling{scrollbar-color:rgba(255,255,255,.2) transparent}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-thumb{background:transparent;border-radius:8px;border:3px solid transparent;background-clip:padding-box;transition:background .3s}
*.scrolling::-webkit-scrollbar-thumb,*:hover::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);background-clip:padding-box}
*::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.3);background-clip:padding-box}
```

- [ ] **Step 2: Wire the import**

In `src/styles/index.css`, add next to the existing panel/workspace imports:

```css
@import "./canvas.css";
```

- [ ] **Step 3: Remove the superseded max rules**

In `src/styles/workspace.css`, delete the two `.grid.has-max .pane{display:none}` / `.grid.has-max .pane.maxed{...}` rules (lines ~114–115). Focus visibility now lives in `canvas.css`.

- [ ] **Step 4: Type-check + build the styles**

Run: `npm run build` (or the project's `tsc --noEmit` + vite build task).
Expected: no CSS/TS errors; app still compiles.

- [ ] **Step 5: Commit**

```bash
git add src/styles/canvas.css src/styles/index.css src/styles/workspace.css
git commit -m "feat(canvas): pane/rail/focus/scrollbar styles"
```

---

### Task 4: `src/main.ts` — canvas positioning + title-bar drag + Tidy

**Files:**
- Modify: `src/main.ts` — `Workspace` interface (~161), `makePaneEl` (~960), `relayout` (~332), the workspace-creation block (~277), and add pointer-drag wiring.

**Interfaces:**
- Consumes: `tileToFit`, `nextSlot`, `serializeLayout`, `parseLayout`, `type Tile` from `./canvas`.
- Produces (used by Task 5): `paneName(pane): string`, `applyLayout(ws)`, `layoutKey(ws): string`.

- [ ] **Step 1: Extend the model + persistence**

- Add to `Pane` (interface ~97): `name: string;`.
- Add to `Workspace` (interface ~161): `layout: Map<string, Tile>;`.
- Add helper `layoutKey(ws)` = `` `maestro.canvas.${ws.dir ?? ws.id}` ``.
- In the workspace-creation block (~295 where `const ws: Workspace = {...}` is built), initialize `layout: new Map(Object.entries(parseLayout(localStorage.getItem(layoutKey(...)))))`.
- Add `function saveLayout(ws){ localStorage.setItem(layoutKey(ws), serializeLayout(Object.fromEntries(ws.layout))); }`.

- [ ] **Step 2: Replace grid tiling with `applyLayout`**

Rename the class on `gridEl` creation (~278) from `"grid"` to `"grid canvas"`. Replace the body of `relayout(ws)` (~332–356) with:

```ts
function applyLayout(ws: Workspace) {
  const area = { width: ws.gridEl.clientWidth || 1280, height: ws.gridEl.clientHeight || 800 };
  for (const [id, p] of ws.panes) {
    let t = ws.layout.get(id);
    if (!t) {
      const existing = [...ws.layout.values()];
      const slot = nextSlot(existing, { w: 540, h: 384, gap: 12 }, area);
      t = { x: slot.x, y: slot.y, w: 540, h: 384 };
      ws.layout.set(id, t);
    }
    p.el.style.left = `${t.x}px`; p.el.style.top = `${t.y}px`;
    p.el.style.width = `${t.w}px`; p.el.style.height = `${t.h}px`;
  }
  saveLayout(ws);
}
```

Replace every existing call to `relayout(ws)` with `applyLayout(ws)`.

- [ ] **Step 3: Add the Tidy action**

```ts
function tidy(ws: Workspace) {
  const area = { width: ws.gridEl.clientWidth, height: ws.gridEl.clientHeight };
  const ids = [...ws.panes.keys()];
  const tiles = tileToFit(ids.length, area);
  ids.forEach((id, i) => ws.layout.set(id, tiles[i]));
  applyLayout(ws);
}
```

Wire the existing dock/topbar to a Tidy control (reuse the `.dr-btn` pattern in `index.html` dock-rail or add a small toolbar button); on click call `tidy(activeWs!)`.

- [ ] **Step 4: Title-bar drag (Pointer Events)**

In `makePaneEl` (~964), prepend a header before `.term-host`:

```ts
`<div class="pane-bar" data-drag>
   <span class="pb-dot"></span>
   <span class="pb-name">${name}</span>
   <span class="pb-cli">${badge}</span>
   <span class="pb-sp"></span>
   <div class="pb-ctrls">
     <button class="pctrl" data-max aria-label="Focus">${MAX_SVG}</button>
     <button class="pctrl danger" data-kill aria-label="Kill">${KILL_SVG}</button>
   </div>
 </div>` + /* existing ai-core-container/find/term-host markup stays below */
```

Add drag wiring (mirrors `src/panels.ts` splitter): on `.pane-bar` pointerdown (ignore clicks on `.pctrl`), `setPointerCapture`, track dx/dy, update `ws.layout.get(id)` x/y live, add `.dragging`; on pointerup persist via `saveLayout(ws)`. A pointerup with < 4px total movement is a no-op (the terminal body handles focus, Task 4b).

- [ ] **Step 5: Test the drag math is guarded (no test file for DOM; verify build)**

Run: `npm run build`
Expected: compiles; `Pane.name` and `Workspace.layout` type-check across all references.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat(canvas): absolute pane layout, title-bar drag, Tidy tiling"
```

---

### Task 5: `src/main.ts` — focus (FLIP) + avatar rail, replacing toggleMax

**Files:**
- Modify: `src/main.ts` — `toggleMax` (~361) → `focusPane`/`exitFocus`; add rail render; the pane double-click / `data-max` handler.

**Interfaces:**
- Consumes: `applyLayout`, `paneName` (Task 4/6).
- Produces: focus state on `ws.gridEl.classList` (`has-focus`) + `.focused` on the pane.

- [ ] **Step 1: Replace `toggleMax`**

```ts
function focusPane(ws: Workspace, pane: Pane) {
  for (const p of ws.panes.values()) p.el.classList.toggle("focused", p === pane);
  ws.gridEl.classList.add("has-focus");
  renderRail(ws, pane);
  pane.term.focus();
}
function exitFocus(ws: Workspace) {
  ws.gridEl.classList.remove("has-focus");
  for (const p of ws.panes.values()) p.el.classList.remove("focused");
  ws.gridEl.querySelector(".cloud-rail")?.remove();
}
```

- [ ] **Step 2: Render the rail**

```ts
function renderRail(ws: Workspace, focused: Pane) {
  let rail = ws.gridEl.querySelector<HTMLElement>(".cloud-rail");
  if (!rail) { rail = document.createElement("aside"); rail.className = "cloud-rail"; ws.gridEl.appendChild(rail); }
  const others = [...ws.panes.values()].filter((p) => p !== focused);
  rail.innerHTML = others.map((p) => {
    const s = paneStatus(p); // running | idle | attention — existing fleet.ts
    return `<button class="rc" data-id="${p.id}" title="${p.name}">
      <span class="av" style="background:${p.color}">${(p.name[0] ?? "?").toUpperCase()}<span class="s ${s}"></span></span>
      <span class="n">${p.name}</span></button>`;
  }).join("");
  rail.querySelectorAll<HTMLElement>(".rc").forEach((rc) =>
    rc.addEventListener("click", () => { const p = ws.panes.get(rc.dataset.id!); if (p) focusPane(ws, p); }));
}
```

- [ ] **Step 3: Wire triggers**

- Clicking the pane's terminal body → `focusPane(activeWs!, pane)` (add a click listener on `.term-host` in `makePaneEl`, skipping when the pane is already focused so typing isn't hijacked; a focused pane's terminal keeps normal xterm behavior).
- `data-max` button → `focusPane`.
- `Escape` (global keydown, when `has-focus`) and a back button in the focused pane's header → `exitFocus(activeWs!)`.
- Guard from the old max-gone bug: in `applyLayout`, if `has-focus` is set but no `.focused` pane exists, call `exitFocus(ws)` (mirrors the retired `.grid.has-max` guard at old ~340).

- [ ] **Step 4: Verify build + manual focus loop**

Run: `npm run build` then launch the app (project run task). Spawn 3 agents, click one → it fills, others become rail avatars; click a rail avatar → swap; Esc → back to canvas.
Expected: no blank-workspace state; typing works in the focused terminal.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat(canvas): focus stage + avatar rail replaces pane maximize"
```

---

### Task 6: `src/main.ts` + `src/crew.ts` — agent identity

**Files:**
- Modify: `src/main.ts` — pane creation (assign name), `makePaneEl` (render name, inline rename), the `MAESTRO_AGENT` env send, and board-assignee matching (search `assignee` usages).

**Interfaces:**
- Consumes: `nameForNewPane` from `./crew`.
- Produces: `paneName(pane) = pane.name`, `renameHook` — a rename that updates `pane.name`, the DOM, and re-exports identity.

- [ ] **Step 1: Assign a name on spawn**

Where a pane is created (the `createAgent`/spawn path that builds the `Pane` object), set:

```ts
const taken = [...ws.panes.values()].map((p) => p.name);
const name = nameForNewPane(spec.badge ?? "agent", taken);
// …store on the Pane: name,
```

Use `name` (not `Claude Code #N`) as the pane's display name everywhere `makePaneEl` currently takes `name`.

- [ ] **Step 2: `MAESTRO_AGENT` uses the display name**

At the spawn env assembly (search `MAESTRO_AGENT`), send `MAESTRO_AGENT=<pane.name>` so the agent, the board `assignee`, and delegation all key off the same human name (extends the Board⇄Agent phase — no protocol change).

- [ ] **Step 3: Inline rename on the title bar**

Add a click handler on `.pb-name`: set `contenteditable`, select all; on blur/Enter commit → `pane.name = text.trim() || pane.name`, update `.pb-name` + the rail avatar letter, and persist. If the board has a card whose `assignee` matched the old name, update it via the existing assignee-set path (search `card.assignee`); a name with no card is fine.

- [ ] **Step 4: Verify build + rename loop**

Run: `npm run build` then launch. Spawn 2 agents → they read `Ana`, `Bob`; rename `Ana`→`Frontend`; confirm the rail + any board chip follow.
Expected: display name is the single identity across pane bar, rail, board.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/crew.ts
git commit -m "feat(identity): persona names on spawn + inline rename wired to MAESTRO_AGENT"
```

---

## Self-Review

- **Spec coverage (Phase 1 of the design):** canvas overview ✓ (Task 4), draggable panes ✓ (Task 4), Tidy tile-to-fit ✓ (Task 4), focus + rail replacing hide ✓ (Task 5), editable identity + `MAESTRO_AGENT` ✓ (Task 6), scrollbar auto-hide ✓ (Task 3). Command bar / voice / delegation and full-screen settings are **out of scope** (Phase 2/3 cards on the board).
- **Placeholder scan:** pure modules carry full code + tests; integration tasks name exact symbols (`Workspace.gridEl`, `makePaneEl`, `toggleMax`, `paneStatus`, `MAESTRO_AGENT`) and show the new functions verbatim. DOM-heavy integration is verified by build + manual loop rather than unit tests, matching the repo (no DOM tests exist for panes).
- **Type consistency:** `Tile`/`Pos`/`Area` names match between `canvas.ts` and `main.ts` consumers; `applyLayout`/`tidy`/`focusPane`/`exitFocus`/`renderRail`/`saveLayout`/`layoutKey` are referenced with the same signatures throughout.

## Out of scope (Phase 2 / Phase 3)

Single-line command bar, `@name` mentions, voice→AI dispatch, delegation visualization (P2); full-screen Settings, background picker (preset/colour/image), English i18n sweep, topbar slimming (P3).
