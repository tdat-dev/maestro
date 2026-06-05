# CLI Crew Spawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free-text command field with a crew builder that picks how many of each known CLI to spawn, launches the mixed fleet without lag, and badges each pane with its CLI.

**Architecture:** Pure logic (CLI registry, crew expansion, concurrency-limited runner) lives in a new `src/crew.ts` so it is unit-testable without the DOM. `index.html` gets a crew grid; `src/main.ts` wires the grid, threads a `badge` through pane creation, and boots processes through a concurrency-limited queue. `src/terminal.ts` caps live WebGL contexts.

**Tech Stack:** TypeScript, Vite, Tauri, xterm.js, vitest.

---

## File Structure

- **Create** `src/crew.ts` — `CliPreset`, `CLI_PRESETS`, `CrewState`, `parseCommand`, `expandCrew`, `runLimited`. No DOM, no Tauri imports.
- **Create** `src/crew.test.ts` — tests for the above.
- **Modify** `src/terminal.ts` — `mountTerminal` gains a WebGL-budget option + live-context counter.
- **Modify** `index.html` — modal: replace "Shell / command" field with crew grid + custom row; dynamic Spawn label.
- **Modify** `src/main.ts` — import crew helpers; thread `badge` into `buildPaneEl`/`createAgent`; build `CrewState` from the grid; boot via `runLimited`.

---

## Task 1: CLI registry + crew expansion (`src/crew.ts`)

**Files:**
- Create: `src/crew.ts`
- Test: `src/crew.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/crew.test.ts
import { describe, it, expect } from "vitest";
import { CLI_PRESETS, parseCommand, expandCrew, type CrewState } from "./crew";

function emptyCrew(): CrewState {
  return { counts: {}, custom: "", customCount: 0 };
}

describe("CLI registry", () => {
  it("includes claude, codex, gemini and a powershell shell", () => {
    const ids = CLI_PRESETS.map((p) => p.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("gemini");
    const ps = CLI_PRESETS.find((p) => p.id === "powershell");
    expect(ps?.program).toBe("powershell.exe");
    expect(ps?.args).toEqual(["-NoLogo"]);
    expect(ps?.shell).toBe(true);
  });
});

describe("parseCommand", () => {
  it("splits a command into program + args", () => {
    expect(parseCommand("aider --model gpt-4")).toEqual({
      program: "aider",
      args: ["--model", "gpt-4"],
    });
  });
  it("returns empty program for blank input", () => {
    expect(parseCommand("   ")).toEqual({ program: "", args: [] });
  });
});

describe("expandCrew", () => {
  it("repeats each preset by its count, in registry order", () => {
    const s: CrewState = { ...emptyCrew(), counts: { claude: 2, codex: 1 } };
    const out = expandCrew(s).map((p) => p.id);
    expect(out).toEqual(["claude", "claude", "codex"]);
  });
  it("appends custom entries when command + count are set", () => {
    const s: CrewState = { counts: { claude: 1 }, custom: "aider", customCount: 2 };
    const out = expandCrew(s);
    expect(out.map((p) => p.id)).toEqual(["claude", "custom", "custom"]);
    expect(out[1]).toMatchObject({ program: "aider", args: [], badge: "custom" });
  });
  it("skips an empty custom command even if count > 0", () => {
    const s: CrewState = { counts: {}, custom: "   ", customCount: 3 };
    expect(expandCrew(s)).toEqual([]);
  });
  it("returns empty for an empty crew", () => {
    expect(expandCrew(emptyCrew())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/crew.test.ts`
Expected: FAIL — cannot resolve `./crew`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/crew.ts

/** A launchable CLI: maps a friendly label to a concrete program + args. */
export interface CliPreset {
  id: string;
  label: string;
  program: string;
  args: string[];
  badge: string;
  shell?: boolean;
}

/** Built-in CLIs offered in the crew picker. Binary names assume the CLI is on
 *  PATH; use the Custom row for anything not listed or named differently. */
export const CLI_PRESETS: CliPreset[] = [
  { id: "claude", label: "Claude Code", program: "claude", args: [], badge: "claude" },
  { id: "codex", label: "Codex", program: "codex", args: [], badge: "codex" },
  { id: "gemini", label: "Gemini", program: "gemini", args: [], badge: "gemini" },
  { id: "aider", label: "Aider", program: "aider", args: [], badge: "aider" },
  { id: "cursor", label: "Cursor Agent", program: "cursor-agent", args: [], badge: "cursor" },
  { id: "opencode", label: "opencode", program: "opencode", args: [], badge: "opencode" },
  { id: "qwen", label: "Qwen Code", program: "qwen", args: [], badge: "qwen" },
  { id: "copilot", label: "GitHub Copilot", program: "copilot", args: [], badge: "copilot" },
  { id: "goose", label: "Goose", program: "goose", args: [], badge: "goose" },
  { id: "powershell", label: "PowerShell", program: "powershell.exe", args: ["-NoLogo"], badge: "shell", shell: true },
  { id: "cmd", label: "CMD", program: "cmd.exe", args: [], badge: "cmd", shell: true },
];

/** Crew the user has composed in the modal: per-preset counts + a custom row. */
export interface CrewState {
  counts: Record<string, number>;
  custom: string;
  customCount: number;
}

/** Split a free-text command into program + args (whitespace-separated). */
export function parseCommand(cmd: string): { program: string; args: string[] } {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  return { program: tokens[0] ?? "", args: tokens.slice(1) };
}

/** Expand a crew into a flat, ordered list of presets to spawn. */
export function expandCrew(state: CrewState): CliPreset[] {
  const out: CliPreset[] = [];
  for (const p of CLI_PRESETS) {
    const n = state.counts[p.id] ?? 0;
    for (let i = 0; i < n; i++) out.push(p);
  }
  const custom = state.custom.trim();
  if (custom && state.customCount > 0) {
    const { program, args } = parseCommand(custom);
    if (program) {
      const cp: CliPreset = { id: "custom", label: custom, program, args, badge: "custom" };
      for (let i = 0; i < state.customCount; i++) out.push(cp);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/crew.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/crew.ts src/crew.test.ts
git commit -m "feat: CLI registry + crew expansion (pure, tested)"
```

---

## Task 2: Concurrency-limited runner (`runLimited`)

**Files:**
- Modify: `src/crew.ts`
- Test: `src/crew.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/crew.test.ts
import { runLimited } from "./crew";

describe("runLimited", () => {
  it("runs every task and preserves order", async () => {
    const tasks = [1, 2, 3, 4, 5].map((n) => () => Promise.resolve(n * 10));
    expect(await runLimited(tasks, 2)).toEqual([10, 20, 30, 40, 50]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const make = () => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return true;
    };
    const tasks = Array.from({ length: 10 }, make);
    await runLimited(tasks, 3);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles an empty task list", async () => {
    expect(await runLimited([], 3)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/crew.test.ts`
Expected: FAIL — `runLimited` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/crew.ts

/** Run async tasks with at most `limit` in flight; results keep input order. */
export async function runLimited<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/crew.test.ts`
Expected: PASS (all of Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/crew.ts src/crew.test.ts
git commit -m "feat: concurrency-limited runner for staggered boot"
```

---

## Task 3: WebGL budget in `mountTerminal`

**Files:**
- Modify: `src/terminal.ts`

- [ ] **Step 1: Update `mountTerminal` to cap live WebGL contexts**

Add a module-level counter + budget, and an options arg. Replace the current
WebGL IIFE so it only attaches while under budget and decrements on dispose.

```ts
// near the top of src/terminal.ts, after imports
const WEBGL_BUDGET = 8;
let liveWebgl = 0;
```

Change the signature:

```ts
export function mountTerminal(
  container: HTMLElement,
  onInput: (data: string) => void,
  onResize: (cols: number, rows: number) => void,
  opts: { webgl?: boolean } = {},
): TerminalHandle {
```

Replace the WebGL IIFE (the `void (async () => { ... })();` block) with:

```ts
  // GPU renderer, but only while under the context budget — browsers cap live
  // WebGL contexts (~16) and thrash past that, which is what makes a big fleet
  // lag. Panes over budget fall back to the default DOM renderer.
  let usedWebgl = false;
  if (opts.webgl !== false && liveWebgl < WEBGL_BUDGET) {
    usedWebgl = true;
    liveWebgl++;
    void (async () => {
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        /* DOM renderer (default) is fine */
      }
    })();
  }
```

Update `dispose` to release the budget slot:

```ts
    dispose: () => {
      ro.disconnect();
      term.dispose();
      if (usedWebgl) liveWebgl--;
    },
```

- [ ] **Step 2: Verify it still type-checks / tests pass**

Run: `npx vitest run src/terminal.test.ts`
Expected: PASS (smoke test still resolves the module).

- [ ] **Step 3: Commit**

```bash
git add src/terminal.ts
git commit -m "perf: cap live WebGL contexts so big fleets don't thrash the GPU"
```

---

## Task 4: Crew grid markup in `index.html`

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add styles for the crew grid**

Append to the MODAL section of the `<style>` block (after the `.chips` rules):

```css
.crew{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.crew-card{display:flex;align-items:center;gap:8px;padding:8px 9px;border:1px solid var(--line);border-radius:var(--r2);background:var(--surface-2)}
.crew-card.on{border-color:var(--accent-dim);background:var(--accent-glow)}
.crew-card .cc-name{flex:1;min-width:0;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.crew-card .cc-badge{font-size:8.5px;font-weight:600;padding:1px 5px;border-radius:4px;background:var(--surface-3);color:var(--muted);border:1px solid var(--line-strong)}
.stepper{display:flex;align-items:center;gap:4px;flex:none}
.stepper button{width:20px;height:20px;border-radius:4px;background:var(--surface-3);color:var(--text-2);display:grid;place-items:center;font-size:14px;line-height:1}
.stepper button:hover{background:var(--line-strong);color:var(--text)}
.stepper .n{min-width:16px;text-align:center;font-variant-numeric:tabular-nums;font-size:12.5px}
.crew-total{font-size:11px;color:var(--muted)}
.crew-total b{color:var(--accent);font-variant-numeric:tabular-nums}
.custom-row{display:flex;gap:6px;align-items:center}
.custom-row .input{flex:1}
```

- [ ] **Step 2: Replace the "Shell / command" field with the crew grid**

Replace this block:

```html
      <div class="field">
        <label for="mProg">Shell / command</label>
        <input class="input" id="mProg" value="powershell.exe -NoLogo" spellcheck="false" autocapitalize="off" autocomplete="off">
      </div>
      <div class="field">
        <label>How many agents</label>
        <div class="chips">
          <button class="chip" data-n="1">1</button>
          <button class="chip" data-n="2">2</button>
          <button class="chip" data-n="4">4</button>
          <button class="chip" data-n="8">8</button>
          <span class="or">or</span>
          <input class="input" id="mCount" type="number" min="1" max="32" value="1" style="max-width:70px;text-align:center">
        </div>
      </div>
```

with:

```html
      <div class="field">
        <label>Crew — pick how many of each CLI</label>
        <div class="crew" id="crewGrid"></div>
      </div>
      <div class="field">
        <label for="mCustom">Custom command</label>
        <div class="custom-row">
          <input class="input" id="mCustom" placeholder="e.g. ollama run llama3" spellcheck="false" autocapitalize="off" autocomplete="off">
          <div class="stepper" data-custom-stepper>
            <button type="button" data-dec aria-label="One fewer">−</button>
            <span class="n" data-custom-n>0</span>
            <button type="button" data-inc aria-label="One more">+</button>
          </div>
        </div>
      </div>
      <div class="crew-total">Total: <b id="crewTotal">0</b> agents</div>
```

- [ ] **Step 3: Give the Spawn button a stable label span**

Replace the Spawn button:

```html
      <button class="btn" id="mSpawn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg> <span id="mSpawnLabel">Spawn</span></button>
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(ui): crew grid markup + custom row + dynamic spawn label"
```

---

## Task 5: Wire the crew in `src/main.ts`

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Import crew helpers**

Replace the top import line for `./terminal` group — add the crew import below the existing imports:

```ts
import { CLI_PRESETS, expandCrew, runLimited, type CrewState, type CliPreset } from "./crew";
```

- [ ] **Step 2: Thread `badge` through pane creation**

Change `buildPaneEl` to accept a badge and render it (replace the hardcoded
`<span class="badge">shell</span>`):

```ts
function buildPaneEl(id: string, name: string, sub: string, badge: string): HTMLElement {
  const el = document.createElement("section");
  el.className = "pane";
  el.dataset.id = id;
  el.innerHTML = `
    <div class="pane-head">
      <span class="dot idle" data-dot></span>
      <span class="pane-name" title="${sub}">${name}</span>
      <span class="badge">${badge}</span>
      <span class="sp"></span>
      <span class="status" data-status>queued…</span>
      <div class="ctrls">
        <button class="pctrl" data-restart aria-label="Restart agent">${RESTART_SVG}</button>
        <button class="pctrl danger" data-kill aria-label="Kill agent (tree)">${KILL_SVG}</button>
      </div>
    </div>
    <div class="term-host" data-host></div>`;
  return el;
}
```

- [ ] **Step 3: Split `createAgent` into mount + boot**

Replace the whole `createAgent` function with a version that mounts the pane
synchronously and returns a `boot` thunk, so the caller can throttle booting.
`badge` is now a parameter.

```ts
interface AgentSpec {
  program: string;
  args: string[];
  cwd: string | null;
  name: string;
  badge: string;
}

// Mount a pane immediately (status "queued…"); return a thunk that boots the
// real process. Splitting mount from boot lets the caller throttle booting so a
// big fleet doesn't spike the CPU all at once.
function createAgent(spec: AgentSpec): () => Promise<void> {
  showWorkspace();
  const id = newId();
  const el = buildPaneEl(id, spec.name, spec.cwd ?? spec.program, spec.badge);
  grid.insertBefore(el, spawnTile);

  const host = el.querySelector<HTMLElement>("[data-host]")!;
  const term = mountTerminal(
    host,
    (data) => {
      if (panes.has(id)) void sendInput(id, data).catch(() => {});
    },
    (cols, rows) => {
      if (panes.has(id)) void resizePty(id, cols, rows).catch(() => {});
    },
  );

  const pane: Pane = { id, el, term, running: false };
  panes.set(id, pane);
  updateCount();

  el.querySelector("[data-kill]")?.addEventListener("click", () => void removeAgent(id));
  el.querySelector("[data-restart]")?.addEventListener("click", async () => {
    await removeAgent(id);
    await createAgent(spec)();
  });

  return async () => {
    if (!panes.has(id)) return; // killed before its turn to boot
    const { cols, rows } = term.fit();
    try {
      await spawnPty(id, spec.program, spec.args, spec.cwd, cols, rows, (bytes) => term.write(bytes));
      pane.running = true;
      setStatus(pane, "running", "run");
      updateCount();
      requestAnimationFrame(() => {
        const s = term.fit();
        if (s.cols !== cols || s.rows !== rows) void resizePty(id, s.cols, s.rows);
      });
    } catch (e) {
      setStatus(pane, "spawn failed", "err");
      term.write(enc.encode(`\r\n\x1b[31m[spawn failed: ${errMsg(e)}]\x1b[0m\r\n`));
    }
  };
}
```

- [ ] **Step 4: Update the Quick-terminal caller**

Replace the `btnQuick` handler to use the new shape:

```ts
document.getElementById("btnQuick")?.addEventListener("click", () => {
  const dir = getRecents()[0] ?? null;
  const ps = CLI_PRESETS.find((p) => p.id === "powershell")!;
  void createAgent({
    program: ps.program,
    args: ps.args,
    cwd: dir,
    name: dir ? basename(dir) : "powershell",
    badge: ps.badge,
  })();
});
```

- [ ] **Step 5: Replace the modal crew state + render**

Replace the modal block from `const STORE_KEY` down through `spawnFromModal`
(everything between `/* spawn-setup modal */` and the `document.getElementById("mSpawn")...`
wiring) with crew-driven logic. Remove references to `mProg`, `mCount`, `chips`,
`syncChips`.

```ts
/* ---------------- spawn-setup modal ---------------- */

const STORE_KEY = "maestro.crew";
const MAX_CONCURRENT_BOOT = 3;
const modal = document.getElementById("spawnModal") as HTMLElement;
const mDir = document.getElementById("mDir") as HTMLInputElement;
const mCustom = document.getElementById("mCustom") as HTMLInputElement;
const crewGrid = document.getElementById("crewGrid") as HTMLElement;
const crewTotalEl = document.getElementById("crewTotal") as HTMLElement;
const spawnLabel = document.getElementById("mSpawnLabel") as HTMLElement;

let crew: CrewState = { counts: {}, custom: "", customCount: 0 };

function loadCrew(): CrewState {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return {
      counts: s.counts && typeof s.counts === "object" ? s.counts : {},
      custom: typeof s.custom === "string" ? s.custom : "",
      customCount: Number.isFinite(s.customCount) ? s.customCount : 0,
      dir: typeof s.dir === "string" ? s.dir : "",
    } as CrewState & { dir: string };
  } catch {
    return { counts: {}, custom: "", customCount: 0 };
  }
}

function crewCount(state: CrewState): number {
  return expandCrew(state).length;
}

function renderCrew() {
  const total = crewCount(crew);
  crewTotalEl.textContent = String(total);
  spawnLabel.textContent = total > 0 ? `Spawn ${total} agent${total > 1 ? "s" : ""}` : "Spawn";
  (document.getElementById("mSpawn") as HTMLButtonElement).disabled = total === 0;
  // per-card counts
  crewGrid.querySelectorAll<HTMLElement>(".crew-card").forEach((card) => {
    const id = card.dataset.id!;
    const n = crew.counts[id] ?? 0;
    card.classList.toggle("on", n > 0);
    const nEl = card.querySelector<HTMLElement>("[data-n]");
    if (nEl) nEl.textContent = String(n);
  });
  const cn = document.querySelector<HTMLElement>("[data-custom-n]");
  if (cn) cn.textContent = String(crew.customCount);
}

function buildCrewGrid() {
  crewGrid.replaceChildren();
  for (const p of CLI_PRESETS) {
    const card = document.createElement("div");
    card.className = "crew-card";
    card.dataset.id = p.id;
    card.innerHTML = `
      <span class="cc-name" title="${p.program}">${p.label}</span>
      <span class="cc-badge">${p.badge}</span>
      <div class="stepper">
        <button type="button" data-dec aria-label="One fewer">−</button>
        <span class="n" data-n>0</span>
        <button type="button" data-inc aria-label="One more">+</button>
      </div>`;
    card.querySelector("[data-dec]")?.addEventListener("click", () => {
      crew.counts[p.id] = Math.max(0, (crew.counts[p.id] ?? 0) - 1);
      renderCrew();
    });
    card.querySelector("[data-inc]")?.addEventListener("click", () => {
      crew.counts[p.id] = Math.min(32, (crew.counts[p.id] ?? 0) + 1);
      renderCrew();
    });
    crewGrid.appendChild(card);
  }
}

function openModal() {
  const saved = loadCrew() as CrewState & { dir?: string };
  crew = { counts: saved.counts, custom: saved.custom, customCount: saved.customCount };
  mDir.value = saved.dir ?? "";
  mCustom.value = crew.custom;
  renderCrew();
  modal.classList.add("open");
  mDir.focus();
  mDir.select();
}
function closeModal() {
  modal.classList.remove("open");
}

mCustom.addEventListener("input", () => {
  crew.custom = mCustom.value;
  renderCrew();
});
document.querySelector("[data-custom-stepper] [data-dec]")?.addEventListener("click", () => {
  crew.customCount = Math.max(0, crew.customCount - 1);
  renderCrew();
});
document.querySelector("[data-custom-stepper] [data-inc]")?.addEventListener("click", () => {
  crew.customCount = Math.min(32, crew.customCount + 1);
  renderCrew();
});

document.getElementById("mBrowse")?.addEventListener("click", async () => {
  const picked = await pickFolder(mDir.value || undefined);
  if (picked) {
    mDir.value = picked;
    mDir.focus();
  }
});

async function spawnFromModal() {
  const dir = mDir.value.trim() || null;
  crew.custom = mCustom.value;
  const fleet = expandCrew(crew);
  if (fleet.length === 0) return;

  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({ counts: crew.counts, custom: crew.custom, customCount: crew.customCount, dir: dir ?? "" }),
  );
  if (dir) addRecent(dir);
  closeModal();

  // Name agents per CLI: "claude #1", "claude #2", plain "codex" when only one.
  const perId: Record<string, number> = {};
  const totals: Record<string, number> = {};
  for (const p of fleet) totals[p.id] = (totals[p.id] ?? 0) + 1;

  const boots = fleet.map((p: CliPreset) => {
    perId[p.id] = (perId[p.id] ?? 0) + 1;
    const base = p.shell && dir ? basename(dir) : p.label;
    const name = totals[p.id] > 1 ? `${base} #${perId[p.id]}` : base;
    return createAgent({ program: p.program, args: p.args, cwd: dir, name, badge: p.badge });
  });

  await runLimited(boots, MAX_CONCURRENT_BOOT);
}
```

- [ ] **Step 6: Build to verify the wiring compiles**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: all tests PASS; `tsc` reports no errors. (If `tsc` flags the `CrewState & { dir }` cast, it is contained to `loadCrew`/`openModal` and resolved by the `as` casts shown.)

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "feat: crew-driven spawn with badges + concurrency-limited boot"
```

---

## Task 6: Manual verification

**Files:** none (run the app)

- [ ] **Step 1: Launch**

Run: `npm run tauri dev`

- [ ] **Step 2: Check the crew flow**
  - Open "New workspace" → the modal shows the crew grid (no free-text shell field).
  - Bump PowerShell to 2 and Claude to 1 → Total shows 3, button reads "Spawn 3 agents".
  - Spawn → three panes appear at once with badges `shell`, `shell`, `claude`; each shows "queued…" then "running" (PowerShell) or "spawn failed" if `claude` is not installed.
  - Confirm panes render without the window stalling.

- [ ] **Step 3: Check custom + persistence**
  - Set Custom command to `cmd.exe`, count 1, spawn → pane badge `custom`, cmd prompt runs.
  - Reopen the modal → previous counts + directory are restored.

- [ ] **Step 4: Commit any fixes found during verification (if needed)**

---

## Self-Review notes

- Spec → tasks: registry (T1), crew builder UI (T4 markup + T5 wiring), lag-aware
  boot queue (T2 `runLimited` + T5 `MAX_CONCURRENT_BOOT`), WebGL budget (T3),
  badge wiring (T5), custom row + skip-empty rule (T1 `expandCrew` + T5),
  persistence (T5), tests (T1, T2). No spec requirement left unmapped.
- `createAgent` changed from `(program, args, cwd, name)` to a single `AgentSpec`
  returning a boot thunk — all call sites (modal, quick, restart) updated in T5.
- `STORE_KEY` moved from `maestro.spawn` to `maestro.crew` (shape changed); old
  saved value is ignored gracefully by `loadCrew`'s try/catch + defaults.
