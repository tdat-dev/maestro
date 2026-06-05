import { mountTerminal, type TerminalHandle } from "./terminal";
import { spawnPty, sendInput, resizePty, killPty, onExit } from "./ipc";

/* Multi-agent grid: each "Spawn agent" = a new pane backed by its own real
 * ConPTY process. They run concurrently; closing a pane kills that agent's
 * whole process tree (Win32 Job Object), independently. */

interface Pane {
  id: string;
  el: HTMLElement;
  term: TerminalHandle;
  running: boolean;
}

const panes = new Map<string, Pane>();
let counter = 0;
const enc = new TextEncoder();

const grid = document.getElementById("grid") as HTMLElement;
const spawnTile = document.getElementById("btnSpawn") as HTMLElement;

const RESTART_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
const KILL_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function newId(): string {
  counter += 1;
  return "agent-" + counter;
}

function buildPaneEl(id: string, name: string): HTMLElement {
  const el = document.createElement("section");
  el.className = "pane";
  el.dataset.id = id;
  el.innerHTML = `
    <div class="pane-head">
      <span class="dot idle" data-dot></span>
      <span class="pane-name">${name}</span>
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

async function createAgent(program = "powershell.exe", args = ["-NoLogo"], name = "powershell") {
  const id = newId();
  const el = buildPaneEl(id, name);
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
    await createAgent(program, args, name);
  });

  const { cols, rows } = term.fit();
  try {
    await spawnPty(id, program, args, cols, rows, (bytes) => term.write(bytes));
    pane.running = true;
    setStatus(pane, "running", "run");
    updateCount();
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
}

// Route pty-exit events to the matching pane.
void onExit((id, code) => {
  const p = panes.get(id);
  if (p) {
    p.running = false;
    setStatus(p, `exited (${code})`, "");
    updateCount();
  }
});

document.getElementById("btnNewAgent")?.addEventListener("click", () => void createAgent());
spawnTile?.addEventListener("click", () => void createAgent());

// live clock
const clk = document.getElementById("clock");
function tick() {
  if (!clk) return;
  const d = new Date();
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  clk.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
tick();
setInterval(tick, 1000);
