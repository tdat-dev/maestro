# Tabbed Workspaces + Close-Confirm — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single agent grid into Chrome-style tabs where each tab is a workspace (its own grid of panes), and make closing the app window confirm + kill all terminals.

**Architecture:** A `Workspace` owns its own grid element + `panes` map; `workspaces: Map` + `activeWs` drive a tab strip. Pure helpers live in `src/workspaces.ts` (tested). The app intercepts the Tauri window close to confirm and `killAll()`.

**Tech Stack:** TypeScript, Vite, Tauri (window + dialog plugins), xterm.js, vitest.

---

## Task 1: Pure workspace helpers (`src/workspaces.ts`)

**Files:** Create `src/workspaces.ts`, `src/workspaces.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/workspaces.test.ts
import { describe, it, expect } from "vitest";
import { basename, nextWorkspaceName, pickNextActive, needsCloseConfirm } from "./workspaces";

describe("basename", () => {
  it("takes the last path segment, slash or backslash", () => {
    expect(basename("D:\\WhaleloSource\\app")).toBe("app");
    expect(basename("/home/me/proj/")).toBe("proj");
  });
});

describe("nextWorkspaceName", () => {
  it("uses the directory basename when a dir is given", () => {
    expect(nextWorkspaceName("D:\\projects\\api", [])).toBe("api");
  });
  it("falls back to the first free 'Workspace N'", () => {
    expect(nextWorkspaceName(null, [])).toBe("Workspace 1");
    expect(nextWorkspaceName(null, ["Workspace 1", "Workspace 2"])).toBe("Workspace 3");
  });
});

describe("pickNextActive", () => {
  it("activates the neighbour after the closed tab", () => {
    expect(pickNextActive(["a", "b", "c"], "b")).toBe("c");
  });
  it("activates the last when the closed tab was last", () => {
    expect(pickNextActive(["a", "b", "c"], "c")).toBe("b");
  });
  it("returns null when closing the only tab", () => {
    expect(pickNextActive(["a"], "a")).toBeNull();
  });
});

describe("needsCloseConfirm", () => {
  it("is true only when terminals are running", () => {
    expect(needsCloseConfirm(0)).toBe(false);
    expect(needsCloseConfirm(3)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`npx vitest run src/workspaces.test.ts`, cannot resolve module)

- [ ] **Step 3: Implement**

```ts
// src/workspaces.ts

/** Last path segment, tolerant of trailing and mixed slashes. */
export function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/** Workspace label: the dir basename, else the first free "Workspace N". */
export function nextWorkspaceName(dir: string | null, taken: string[]): string {
  if (dir) return basename(dir);
  let n = 1;
  while (taken.includes(`Workspace ${n}`)) n++;
  return `Workspace ${n}`;
}

/** Which workspace id to activate after `closingId` is removed (neighbour to
 *  the right, else the last; null if it was the only one). */
export function pickNextActive(ids: string[], closingId: string): string | null {
  const rest = ids.filter((x) => x !== closingId);
  if (rest.length === 0) return null;
  const i = ids.indexOf(closingId);
  return rest[Math.min(i, rest.length - 1)];
}

/** Confirm before quitting only when at least one terminal is live. */
export function needsCloseConfirm(total: number): boolean {
  return total > 0;
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit** — `git commit -m "feat: pure workspace helpers (naming, next-active, close-confirm)"`

---

## Task 2: IPC wrappers for window close + confirm (`src/ipc.ts`)

**Files:** Modify `src/ipc.ts`

- [ ] **Step 1: Add wrappers**

```ts
// add imports at top
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";

// append exports
/** Native confirm dialog. Returns true if the user accepts. */
export async function confirmDialog(message: string, title: string): Promise<boolean> {
  return confirm(message, { title, kind: "warning" });
}

/** Register a handler for the window's close (X) button. Call event.preventDefault()
 *  inside to keep the window open. */
export async function onWindowClose(
  handler: (event: { preventDefault(): void }) => void | Promise<void>,
): Promise<void> {
  await getCurrentWindow().onCloseRequested(handler);
}

/** Force the window closed without re-firing onCloseRequested. */
export async function destroyWindow(): Promise<void> {
  await getCurrentWindow().destroy();
}
```

- [ ] **Step 2: Grant window permissions** — edit `src-tauri/capabilities/default.json`, add to `permissions`:

```json
    "core:window:allow-close",
    "core:window:allow-destroy"
```

- [ ] **Step 3: Typecheck** — `npx tsc --noEmit` → no errors.

- [ ] **Step 4: Commit** — `git commit -m "feat: ipc wrappers for window close-request + confirm dialog"`

---

## Task 3: Tab strip markup + styles (`index.html`)

**Files:** Modify `index.html`

- [ ] **Step 1: Replace the workspace body** — change the `<main>` block so grids
  live in a host and add a tab strip row. Replace:

```html
  <main class="main">
    <div class="grid" id="grid">
      <button class="tile-spawn" id="btnSpawn">
        <span class="ic">…</span>
        <span class="t">Spawn agent</span>
        <span class="sub">real ConPTY · type · tree-kill</span>
      </button>
    </div>
  </main>
```

with:

```html
  <nav class="tabstrip" id="tabstrip">
    <button class="tab-add" id="tabAdd" aria-label="New workspace"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button>
  </nav>
  <main class="main" id="workspaces"></main>
```

- [ ] **Step 2: Update `.app` rows + add tabstrip styles.** Change
  `.app{...grid-template-rows:50px 1fr...}` to `50px 40px 1fr`, and append after
  the `.clock` rule:

```css
.tabstrip{display:flex;align-items:center;gap:6px;padding:0 10px;background:#0e131a;border-bottom:1px solid var(--line);overflow-x:auto;overflow-y:hidden}
.tabstrip::-webkit-scrollbar{height:0}
.tab{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 8px 0 10px;border-radius:7px 7px 0 0;border:1px solid transparent;border-bottom:none;color:var(--muted);background:transparent;font-size:12px;font-weight:600;white-space:nowrap;flex:none;transition:background .14s,color .14s}
.tab:hover{background:var(--surface-1);color:var(--text-2)}
.tab.active{background:var(--surface-2);color:var(--text);border-color:var(--line)}
.tab .tdot{width:7px;height:7px;border-radius:50%;background:var(--idle)}
.tab.live .tdot{background:var(--run);box-shadow:0 0 0 0 rgba(58,210,159,.5);animation:pulse 2.2s infinite}
.tab .tcount{font-size:10px;color:var(--muted-2);font-variant-numeric:tabular-nums}
.tab .tclose{width:17px;height:17px;border-radius:4px;display:grid;place-items:center;color:var(--muted-2);margin-left:1px}
.tab .tclose:hover{background:var(--surface-3);color:var(--err)}
.tab-add{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;color:var(--muted);flex:none}
.tab-add:hover{background:var(--surface-1);color:var(--accent)}
```

- [ ] **Step 3: Commit** — `git commit -m "feat(ui): tab strip markup + styles"`

---

## Task 4: Workspace model + tabs in `src/main.ts`

**Files:** Modify `src/main.ts`

This task rewires panes to be per-workspace. Apply in order.

- [ ] **Step 1: Imports + state.** Add the workspaces import; replace `basename`
  usage to come from the module; replace the single `grid`/`spawnTile`/`panes`
  globals.

Add import:

```ts
import { nextWorkspaceName, pickNextActive, needsCloseConfirm, basename } from "./workspaces";
import { /* existing */ killAll, onWindowClose, confirmDialog, destroyWindow } from "./ipc";
```

Remove the local `function basename(...)` in main.ts (now imported).

Replace:

```ts
const panes = new Map<string, Pane>();
```

with:

```ts
interface Workspace {
  id: string;
  name: string;
  dir: string | null;
  gridEl: HTMLElement;
  tabEl: HTMLElement;
  panes: Map<string, Pane>;
}
const workspaces = new Map<string, Workspace>();
let activeWs: Workspace | null = null;
let wsCounter = 0;
```

Replace the element grabs:

```ts
const homeEl = document.getElementById("home") as HTMLElement;
const appEl = document.getElementById("app") as HTMLElement;
const grid = document.getElementById("grid") as HTMLElement;
const spawnTile = document.getElementById("btnSpawn") as HTMLElement;
```

with:

```ts
const homeEl = document.getElementById("home") as HTMLElement;
const appEl = document.getElementById("app") as HTMLElement;
const wsHost = document.getElementById("workspaces") as HTMLElement;
const tabstrip = document.getElementById("tabstrip") as HTMLElement;
const tabAdd = document.getElementById("tabAdd") as HTMLElement;
```

- [ ] **Step 2: showView + workspace create/activate/remove.** Replace `showView`
  and add workspace management:

```ts
function showWorkspace() {
  homeEl.hidden = true;
  appEl.hidden = false;
}
function showView() {
  if (workspaces.size > 0) showWorkspace();
  else {
    appEl.hidden = true;
    homeEl.hidden = false;
  }
}

const SPAWN_TILE_SVG =
  '<span class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span><span class="t">Spawn agent</span><span class="sub">real ConPTY · type · tree-kill</span>';

function createWorkspace(dir: string | null): Workspace {
  wsCounter += 1;
  const id = `ws-${wsCounter}`;
  const name = nextWorkspaceName(dir, [...workspaces.values()].map((w) => w.name));

  const gridEl = document.createElement("div");
  gridEl.className = "grid";
  const tile = document.createElement("button");
  tile.className = "tile-spawn";
  tile.innerHTML = SPAWN_TILE_SVG;
  tile.addEventListener("click", () => openModal("current"));
  gridEl.appendChild(tile);
  wsHost.appendChild(gridEl);

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.innerHTML =
    `<span class="tdot"></span><span class="tname"></span><span class="tcount"></span>` +
    `<button class="tclose" aria-label="Close workspace">${KILL_SVG}</button>`;
  tabEl.querySelector(".tname")!.textContent = name;
  tabstrip.insertBefore(tabEl, tabAdd);

  const ws: Workspace = { id, name, dir, gridEl, tabEl, panes: new Map() };
  tabEl.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".tclose")) return;
    activateWorkspace(ws);
  });
  tabEl.querySelector(".tclose")!.addEventListener("click", (e) => {
    e.stopPropagation();
    void removeWorkspace(ws);
  });

  workspaces.set(id, ws);
  activateWorkspace(ws);
  return ws;
}

function activateWorkspace(ws: Workspace) {
  activeWs = ws;
  for (const w of workspaces.values()) {
    w.gridEl.hidden = w !== ws;
    w.tabEl.classList.toggle("active", w === ws);
  }
  showWorkspace();
}

async function removeWorkspace(ws: Workspace) {
  if (ws.panes.size > 0) {
    const ok = await confirmDialog(
      `Đóng workspace "${ws.name}" — ${ws.panes.size} terminal sẽ bị tắt?`,
      "Đóng workspace",
    );
    if (!ok) return;
  }
  for (const id of [...ws.panes.keys()]) await removeAgent(ws, id);
  const ids = [...workspaces.keys()];
  const nextId = pickNextActive(ids, ws.id);
  ws.gridEl.remove();
  ws.tabEl.remove();
  workspaces.delete(ws.id);
  if (activeWs === ws) {
    const next = nextId ? workspaces.get(nextId) ?? null : null;
    if (next) activateWorkspace(next);
    else {
      activeWs = null;
      showView();
    }
  }
  updateCount();
}
```

- [ ] **Step 3: Per-workspace `createAgent` / `removeAgent`.** Change `createAgent`
  to take a `Workspace`, mount into `ws.gridEl` before its spawn tile, store in
  `ws.panes`. Change `removeAgent` to `(ws, id)`. Update the restart handler.

In `createAgent`, change the signature and the three references:

```ts
function createAgent(ws: Workspace, spec: AgentSpec): () => Promise<void> {
  showWorkspace();
  const id = newId();
  const sub = spec.cwd ? basename(spec.cwd) : "";
  const el = buildPaneEl(id, spec.name, sub, spec.badge, spec.color, spec.mono);
  ws.gridEl.insertBefore(el, ws.gridEl.lastElementChild); // before the spawn tile
  // …mountTerminal block unchanged…
  const pane: Pane = { id, el, term, running: false, spawnedAt: null };
  ws.panes.set(id, pane);
  updateCount();

  el.querySelector("[data-kill]")?.addEventListener("click", () => void removeAgent(ws, id));
  el.querySelector("[data-restart]")?.addEventListener("click", async () => {
    await removeAgent(ws, id);
    await createAgent(ws, spec)();
  });
  // …boot thunk unchanged except `panes.has(id)` → `ws.panes.has(id)`…
}
```

Replace every `panes.has(id)` inside the input/resize callbacks and boot thunk
with `ws.panes.has(id)`.

`removeAgent`:

```ts
async function removeAgent(ws: Workspace, id: string) {
  const p = ws.panes.get(id);
  if (!p) return;
  try { await killPty(id); } catch { /* ignore */ }
  p.term.dispose();
  p.el.remove();
  ws.panes.delete(id);
  updateCount();
}
```

- [ ] **Step 4: Global helpers across workspaces.** Replace `updateCount`, `tick`
  uptime loop, and the `pty-exit` listener to iterate workspaces; update each
  tab's count + live dot.

```ts
function updateCount() {
  let totalRun = 0;
  let total = 0;
  for (const w of workspaces.values()) {
    const run = [...w.panes.values()].filter((p) => p.running).length;
    totalRun += run;
    total += w.panes.size;
    const c = w.tabEl.querySelector<HTMLElement>(".tcount");
    if (c) c.textContent = w.panes.size ? String(w.panes.size) : "";
    w.tabEl.classList.toggle("live", run > 0);
  }
  const run = document.getElementById("runCount");
  if (run) run.textContent = String(totalRun);
  const tot = document.getElementById("agentCount");
  if (tot) tot.textContent = String(total);
}
```

In `tick()` replace `for (const pane of panes.values())` with:

```ts
  for (const w of workspaces.values())
    for (const pane of w.panes.values()) {
      if (pane.running && pane.spawnedAt != null) {
        const u = pane.el.querySelector<HTMLElement>("[data-uptime]");
        if (u) u.textContent = fmtUptime(now - pane.spawnedAt);
      }
    }
```

The `onExit` listener — find the pane across workspaces:

```ts
onExit((id, code) => {
  for (const w of workspaces.values()) {
    const p = w.panes.get(id);
    if (p) {
      p.running = false;
      p.spawnedAt = null;
      setStatus(p, `exited (${code})`, "");
      updateCount();
      break;
    }
  }
}).catch((e) => console.warn("pty-exit listener unavailable:", e));
```

- [ ] **Step 5: Typecheck** — `npx tsc --noEmit`. Expect errors only where the
  modal still calls `createAgent` with the old signature; fixed in Task 5.

---

## Task 5: Modal targets the active workspace + entry points

**Files:** Modify `src/main.ts`

- [ ] **Step 1: Modal mode.** Add a target mode and make `openModal` accept it.

```ts
let modalTarget: "new" | "current" = "new";
```

In `openModal`, set it and prefill the dir from the active workspace when adding:

```ts
function openModal(mode: "new" | "current" = "new") {
  modalTarget = mode;
  const saved = loadCrew();
  crew = { counts: saved.counts, custom: saved.custom, customCount: saved.customCount };
  mDir.value = mode === "current" && activeWs ? activeWs.dir ?? "" : saved.dir;
  mCustom.value = crew.custom;
  renderCrew();
  modal.classList.add("open");
  mDir.focus();
  mDir.select();
}
```

- [ ] **Step 2: spawnFromModal picks/creates the workspace.** Replace the agent-
  creation section of `spawnFromModal`:

```ts
  const ws =
    modalTarget === "current" && activeWs ? activeWs : createWorkspace(dir);
  if (modalTarget === "current" && activeWs && !activeWs.dir && dir) activeWs.dir = dir;

  const boots = fleet.map((p: CliPreset) => {
    perId[p.id] = (perId[p.id] ?? 0) + 1;
    const base = p.shell && dir ? basename(dir) : p.label;
    const name = totals[p.id] > 1 ? `${base} #${perId[p.id]}` : base;
    return createAgent(ws, {
      program: p.program, args: p.args, cwd: dir, name, badge: p.badge,
      ...cliLook(p.badge, p.label),
    });
  });
  await runLimited(boots, MAX_CONCURRENT_BOOT);
```

- [ ] **Step 3: Wire entry points.** Update the trigger listeners:

```ts
document.getElementById("btnNewWorkspace")?.addEventListener("click", () => openModal("new"));
document.getElementById("btnNewAgent")?.addEventListener("click", () => openModal("current"));
tabAdd?.addEventListener("click", () => openModal("new"));
```

Remove the old `spawnTile?.addEventListener(...)` line (per-grid tiles are wired
in `createWorkspace`).

- [ ] **Step 4: Quick terminal → its own workspace.** Update `btnQuick` to create
  a workspace then spawn into it:

```ts
document.getElementById("btnQuick")?.addEventListener("click", () => {
  const dir = getRecents()[0] ?? null;
  const ps = CLI_PRESETS.find((p) => p.id === "powershell")!;
  const ws = createWorkspace(dir);
  void createAgent(ws, {
    program: ps.program, args: ps.args, cwd: dir,
    name: dir ? basename(dir) : "powershell", badge: ps.badge,
    ...cliLook(ps.badge, ps.label),
  })();
});
```

- [ ] **Step 5: Typecheck + build** — `npx tsc --noEmit` then `npm run build`. Both clean.

- [ ] **Step 6: Commit** — `git commit -m "feat: tabbed workspaces — per-tab grids, spawn into active tab"`

---

## Task 6: Close-app confirmation + kill all

**Files:** Modify `src/main.ts`

- [ ] **Step 1: Register the close handler** near the init block (after the
  `onExit` wiring):

```ts
let closing = false;
void onWindowClose(async (event) => {
  if (closing) return;
  let total = 0;
  for (const w of workspaces.values()) total += w.panes.size;
  if (!needsCloseConfirm(total)) return; // nothing running — let it close
  event.preventDefault();
  const ok = await confirmDialog(
    `${total} terminal đang chạy sẽ bị tắt. Đóng Maestro?`,
    "Đóng Maestro",
  );
  if (ok) {
    closing = true;
    try { await killAll(); } catch { /* ignore */ }
    await destroyWindow();
  }
}).catch((e) => console.warn("close handler unavailable:", e));
```

- [ ] **Step 2: Build** — `npm run build` clean.

- [ ] **Step 3: Commit** — `git commit -m "feat: confirm + tree-kill all terminals on window close"`

---

## Task 7: Manual verification (built app)

- [ ] Run `npm run tauri dev`.
- [ ] Home → New workspace → pick dir + crew (e.g. 2 PowerShell) → spawns in a tab named after the folder.
- [ ] Tab "+" → New workspace with a different crew → second tab; click between tabs switches grids; live dot + count per tab correct.
- [ ] "New agent" adds a pane to the **current** tab.
- [ ] Close a tab with agents → confirm dialog → agents die, tab gone, neighbour activates. Close last tab → Home.
- [ ] Press the window X with agents running → confirm dialog → Yes kills all + quits; No keeps it open. X with zero agents → closes immediately.

---

## Self-Review notes

- Spec → tasks: workspace model (T4), tab strip (T3 markup + T4 render), spawn-
  into-active + new-tab entry points (T5), tab close confirm (T4 `removeWorkspace`),
  window close confirm + killAll (T2 wrappers + T6), pure helpers + tests (T1),
  capability perms (T2). All spec requirements mapped.
- `createAgent` signature changes to `(ws, spec)`; every call site (modal, quick,
  restart) updated in T4/T5. `removeAgent` → `(ws, id)`.
- `basename` moves from main.ts into `workspaces.ts` (imported) — single source.
- Per-grid spawn tiles wired in `createWorkspace`; the old static `#btnSpawn` /
  `#grid` are gone (replaced by `#workspaces` host + `#tabstrip`).
