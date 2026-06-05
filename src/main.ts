import { mountTerminal, type TerminalHandle } from "./terminal";
import { spawnPty, sendInput, resizePty, killPty, onExit } from "./ipc";

/* ====================================================================
 * Focused pane = a REAL agent running under a Windows ConPTY.
 * Spawn -> live PTY -> type into it -> Kill tears down the whole tree
 * via a Win32 Job Object (verified by the Rust integration tests).
 * ==================================================================== */

const host = document.getElementById("liveTerm") as HTMLElement;
const empty = document.getElementById("termEmpty") as HTMLElement | null;
const statusEl = document.getElementById("agentStatus");
const dotEl = document.getElementById("agentDot");
const nameEl = document.getElementById("agentName");
const countEl = document.getElementById("agentCount");

let term: TerminalHandle | null = null;
let running = false;
let unlistenExit: (() => void) | null = null;

function setStatus(text: string, cls: "" | "run" | "err") {
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.className = "agent-status" + (cls ? " " + cls : "");
  }
}
function setDot(state: "idle" | "run" | "err" | "await") {
  if (dotEl) dotEl.className = "dot " + state;
}
function setCount(n: number) {
  if (countEl) countEl.textContent = String(n);
}
function clearExit() {
  if (unlistenExit) {
    unlistenExit();
    unlistenExit = null;
  }
}

function ensureTerm(): TerminalHandle {
  if (term) return term;
  if (empty) empty.style.display = "none";
  term = mountTerminal(
    host,
    (data) => {
      if (running) void sendInput(data);
    },
    (cols, rows) => {
      if (running) void resizePty(cols, rows);
    },
  );
  return term;
}

async function spawnAgent() {
  const t = ensureTerm();
  if (running) {
    try {
      await killPty();
    } catch {
      /* ignore */
    }
    clearExit();
    running = false;
  }
  t.reset();
  const { cols, rows } = t.fit();
  setStatus("spawning…", "");
  setDot("idle");
  if (nameEl) nameEl.textContent = "powershell";
  try {
    await spawnPty("powershell.exe", ["-NoLogo"], cols, rows, (bytes) => t.write(bytes));
    running = true;
    setStatus("running", "run");
    setDot("run");
    setCount(1);
    unlistenExit = await onExit((code) => {
      running = false;
      setStatus(`exited (${code})`, "");
      setDot("idle");
      setCount(0);
    });
  } catch (e) {
    setStatus("spawn failed", "err");
    setDot("err");
    t.write(new TextEncoder().encode(`\r\n\x1b[31m[spawn failed: ${String(e)}]\x1b[0m\r\n`));
  }
}

async function killAgent() {
  try {
    await killPty();
  } catch {
    /* ignore */
  }
  clearExit();
  running = false;
  setStatus("killed", "");
  setDot("idle");
  setCount(0);
}

document.getElementById("btnNewAgent")?.addEventListener("click", () => void spawnAgent());
document.getElementById("btnSpawn")?.addEventListener("click", () => void spawnAgent());
document.getElementById("btnSpawnInline")?.addEventListener("click", () => void spawnAgent());
document.getElementById("btnRestart")?.addEventListener("click", () => void spawnAgent());
document.getElementById("btnKill")?.addEventListener("click", () => void killAgent());

/* ====================================================================
 * Mission-control shell interactions (Direction B).
 * ==================================================================== */

// live clock
const clk = document.getElementById("clock");
const zone = document.getElementById("clockzone");
try {
  if (zone) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    zone.textContent = tz.split("/").pop()!.replace("_", " ").toLowerCase();
  }
} catch {
  /* keep default */
}
function tick() {
  if (!clk) return;
  const d = new Date();
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  clk.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
tick();
setInterval(tick, 1000);

// dock tabs
const tabs = Array.from(document.querySelectorAll<HTMLElement>(".tab"));
tabs.forEach((t) => {
  t.addEventListener("click", () => {
    tabs.forEach((x) => {
      x.classList.remove("active");
      x.setAttribute("aria-selected", "false");
    });
    t.classList.add("active");
    t.setAttribute("aria-selected", "true");
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    document.getElementById("panel-" + t.dataset.panel)?.classList.add("active");
  });
});

// activity filter chips
document.querySelectorAll<HTMLElement>(".fchip").forEach((c) => {
  c.addEventListener("click", () => {
    document.querySelectorAll(".fchip").forEach((x) => x.classList.remove("on"));
    c.classList.add("on");
  });
});

// activity collapse
const act = document.getElementById("activity");
const cb = document.getElementById("collapseBtn");
cb?.addEventListener("click", () => {
  const collapsed = act?.classList.toggle("collapsed");
  cb.setAttribute("aria-expanded", String(!collapsed));
  if (cb.firstChild) cb.firstChild.textContent = collapsed ? "Expand " : "Collapse ";
});

// composer autosize
const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea");
ta?.addEventListener("input", () => {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 90) + "px";
});
