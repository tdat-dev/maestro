import { mountTerminal, type TerminalHandle } from "./terminal";
import { spawnPty, sendInput, resizePty, killPty, onExit, pickFolder } from "./ipc";

/* Home launcher ⇄ Workspace grid.
 * Home is shown while there are 0 agents (the prominent "create" entry).
 * Spawning agents switches to the Workspace; closing them all returns Home.
 * Each agent = its own real ConPTY process; closing a pane tree-kills it. */

interface Pane {
  id: string;
  el: HTMLElement;
  term: TerminalHandle;
  running: boolean;
}

const panes = new Map<string, Pane>();
let counter = 0;
const enc = new TextEncoder();

const homeEl = document.getElementById("home") as HTMLElement;
const appEl = document.getElementById("app") as HTMLElement;
const grid = document.getElementById("grid") as HTMLElement;
const spawnTile = document.getElementById("btnSpawn") as HTMLElement;

function showWorkspace() {
  homeEl.hidden = true;
  appEl.hidden = false;
}
function showView() {
  if (panes.size > 0) {
    showWorkspace();
  } else {
    appEl.hidden = true;
    homeEl.hidden = false;
  }
}

const RESTART_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
const KILL_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function newId(): string {
  counter += 1;
  return "agent-" + counter;
}

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

function buildPaneEl(id: string, name: string, sub: string): HTMLElement {
  const el = document.createElement("section");
  el.className = "pane";
  el.dataset.id = id;
  el.innerHTML = `
    <div class="pane-head">
      <span class="dot idle" data-dot></span>
      <span class="pane-name" title="${sub}">${name}</span>
      <span class="badge">shell</span>
      <span class="sp"></span>
      <span class="status" data-status>spawning…</span>
      <div class="ctrls">
        <button class="pctrl" data-restart aria-label="Restart agent">${RESTART_SVG}</button>
        <button class="pctrl danger" data-kill aria-label="Kill agent (tree)">${KILL_SVG}</button>
      </div>
    </div>
    <div class="term-host" data-host></div>`;
  return el;
}

function setStatus(p: Pane, text: string, cls: "" | "run" | "err") {
  const s = p.el.querySelector<HTMLElement>("[data-status]");
  if (s) {
    s.textContent = text;
    s.className = "status" + (cls ? " " + cls : "");
  }
  const d = p.el.querySelector<HTMLElement>("[data-dot]");
  if (d) d.className = "dot " + (cls === "run" ? "run" : cls === "err" ? "err" : "idle");
  p.el.classList.toggle("err", cls === "err");
}

function updateCount() {
  const c = document.getElementById("agentCount");
  if (c) c.textContent = String([...panes.values()].filter((p) => p.running).length);
}

async function createAgent(program: string, args: string[], cwd: string | null, name: string) {
  // Make the (sized) workspace grid visible BEFORE mounting xterm, otherwise
  // fit() measures a display:none container as 0×0 and ConPTY paints the prompt
  // at the wrong size (blank pane).
  showWorkspace();
  const id = newId();
  const el = buildPaneEl(id, name, cwd ?? program);
  grid.insertBefore(el, spawnTile);

  const host = el.querySelector<HTMLElement>("[data-host]")!;
  const term = mountTerminal(
    host,
    (data) => {
      const p = panes.get(id);
      if (p?.running) void sendInput(id, data);
    },
    (cols, rows) => {
      const p = panes.get(id);
      if (p?.running) void resizePty(id, cols, rows);
    },
  );

  const pane: Pane = { id, el, term, running: false };
  panes.set(id, pane);
  updateCount();

  el.querySelector("[data-kill]")?.addEventListener("click", () => void removeAgent(id));
  el.querySelector("[data-restart]")?.addEventListener("click", async () => {
    await removeAgent(id);
    await createAgent(program, args, cwd, name);
  });

  const { cols, rows } = term.fit();
  try {
    await spawnPty(id, program, args, cwd, cols, rows, (bytes) => term.write(bytes));
    pane.running = true;
    setStatus(pane, "running", "run");
    updateCount();
    // Re-fit once the grid layout has settled; correct the PTY size if it moved.
    requestAnimationFrame(() => {
      const s = term.fit();
      if (s.cols !== cols || s.rows !== rows) void resizePty(id, s.cols, s.rows);
    });
  } catch (e) {
    setStatus(pane, "spawn failed", "err");
    term.write(enc.encode(`\r\n\x1b[31m[spawn failed: ${String(e)}]\x1b[0m\r\n`));
  }
}

async function removeAgent(id: string) {
  const p = panes.get(id);
  if (!p) return;
  try {
    await killPty(id);
  } catch {
    /* ignore */
  }
  p.term.dispose();
  p.el.remove();
  panes.delete(id);
  updateCount();
  showView();
}

/* ---------------- recent folders ---------------- */

const RECENT_KEY = "maestro.recent";
function getRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function addRecent(dir: string) {
  if (!dir) return;
  const list = [dir, ...getRecents().filter((d) => d !== dir)].slice(0, 6);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  renderRecents();
}
function renderRecents() {
  const wrap = document.getElementById("recents");
  const list = document.getElementById("recentsList");
  if (!wrap || !list) return;
  const r = getRecents();
  if (r.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  list.replaceChildren();
  for (const dir of r) {
    const b = document.createElement("button");
    b.className = "recent-chip";
    b.title = dir;
    b.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>${dir}</span>`;
    b.addEventListener("click", () => {
      openModal();
      mDir.value = dir;
    });
    list.appendChild(b);
  }
}

/* ---------------- spawn-setup modal ---------------- */

const STORE_KEY = "maestro.spawn";
const modal = document.getElementById("spawnModal") as HTMLElement;
const mDir = document.getElementById("mDir") as HTMLInputElement;
const mProg = document.getElementById("mProg") as HTMLInputElement;
const mCount = document.getElementById("mCount") as HTMLInputElement;
const chips = Array.from(document.querySelectorAll<HTMLElement>(".chip"));

interface Saved {
  dir: string;
  cmd: string;
  count: number;
}
function loadSaved(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return { dir: s.dir ?? "", cmd: s.cmd || "powershell.exe -NoLogo", count: s.count || 1 };
  } catch {
    return { dir: "", cmd: "powershell.exe -NoLogo", count: 1 };
  }
}
function syncChips() {
  const n = mCount.value;
  chips.forEach((c) => c.classList.toggle("on", c.dataset.n === n));
}
function openModal() {
  const s = loadSaved();
  mDir.value = s.dir;
  mProg.value = s.cmd;
  mCount.value = String(s.count);
  syncChips();
  modal.classList.add("open");
  mDir.focus();
  mDir.select();
}
function closeModal() {
  modal.classList.remove("open");
}

chips.forEach((c) => {
  c.addEventListener("click", () => {
    mCount.value = c.dataset.n || "1";
    syncChips();
  });
});
mCount.addEventListener("input", syncChips);

document.getElementById("mBrowse")?.addEventListener("click", async () => {
  const picked = await pickFolder(mDir.value || undefined);
  if (picked) {
    mDir.value = picked;
    mDir.focus();
  }
});

async function spawnFromModal() {
  const dir = mDir.value.trim() || null;
  const cmd = mProg.value.trim() || "powershell.exe";
  const count = Math.min(32, Math.max(1, parseInt(mCount.value, 10) || 1));

  const tokens = cmd.split(/\s+/);
  const program = tokens[0];
  const args = tokens.slice(1);
  const base = dir ? basename(dir) : basename(program).replace(/\.exe$/i, "");

  localStorage.setItem(STORE_KEY, JSON.stringify({ dir: dir ?? "", cmd, count }));
  if (dir) addRecent(dir);
  closeModal();

  for (let i = 1; i <= count; i++) {
    const name = count > 1 ? `${base} #${i}` : base;
    await createAgent(program, args, dir, name);
  }
}

document.getElementById("mSpawn")?.addEventListener("click", () => void spawnFromModal());
document.getElementById("mCancel")?.addEventListener("click", closeModal);
document.getElementById("mClose")?.addEventListener("click", closeModal);
modal.addEventListener("mousedown", (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modal.classList.contains("open")) closeModal();
});

/* ---------------- home + workspace triggers ---------------- */

document.getElementById("btnNewWorkspace")?.addEventListener("click", openModal);
document.getElementById("btnNewAgent")?.addEventListener("click", openModal);
spawnTile?.addEventListener("click", openModal);

document.getElementById("btnQuick")?.addEventListener("click", () => {
  const dir = getRecents()[0] ?? null;
  void createAgent("powershell.exe", ["-NoLogo"], dir, dir ? basename(dir) : "powershell");
});

/* ---------------- clock ---------------- */
const clk = document.getElementById("clock");
function tick() {
  if (!clk) return;
  const d = new Date();
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  clk.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
tick();
setInterval(tick, 1000);

/* ---------------- init ---------------- */
renderRecents();
showView();

/* pty-exit listener LAST + guarded so it can never block the wiring above. */
onExit((id, code) => {
  const p = panes.get(id);
  if (p) {
    p.running = false;
    setStatus(p, `exited (${code})`, "");
    updateCount();
  }
}).catch((e) => console.warn("pty-exit listener unavailable:", e));
