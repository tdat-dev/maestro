// Pane lifecycle: build a pane's DOM, boot/attach/kill its PTY, session
// recording (replay), and the "needs you" attention heuristic. Split from
// main.ts; main-only helpers (error formatting, the live counters, home/tray
// bookkeeping, find-in-output wiring) are injected via configurePane to avoid
// a circular import.

import { mountTerminal } from "./terminal";
import {
  sendInput,
  resizePty,
  killPty,
  spawnPty,
  attachPty,
  openExternal,
  worktreeAdd,
  notify,
  recordStart,
  recordStop,
} from "./ipc";
import { branchName } from "./worktree";
import { getTermFontSize } from "./settings";
import { launchSpec } from "./crew";
import { type Pane, type Workspace, type AgentSpec } from "./panetypes";
import { layoutGrid, wirePaneDrag, wirePaneRename, toggleMax } from "./panelayout";
import { saveSession } from "./session";
import { openReplays, REC_DIR_REL } from "./replay";
import { workspaces, newId } from "./appstate";
import { basename } from "./workspaces";

let onErrMsg: (e: unknown) => string = (e) => String(e);
let onUpdateCount: () => void = () => {};
let onShowWorkspace: () => void = () => {};
let onWirePaneSearch: (pane: Pane) => void = () => {};
export function configurePane(deps: {
  errMsg: (e: unknown) => string;
  updateCount: () => void;
  showWorkspace: () => void;
  wirePaneSearch: (pane: Pane) => void;
}): void {
  onErrMsg = deps.errMsg;
  onUpdateCount = deps.updateCount;
  onShowWorkspace = deps.showWorkspace;
  onWirePaneSearch = deps.wirePaneSearch;
}

// The board protocol every Maestro-spawned Claude agent is forced to follow
// (injected via --append-system-prompt). One line, and free of cmd.exe
// metacharacters (& | < > % ! ^ ( ) " ') so it survives the cmd /c launch path.
const MAESTRO_LAWS =
  "You are running inside Maestro, which gives this workspace a shared kanban board through the maestro MCP tools. For any non-trivial task you MUST plan on the board before implementing. First call board_get. Then for each deliverable call card_add in the Proposed list with a short title, a one-line desc, and the small concrete steps as the checklist array. Prefer few big cards over many tiny ones. Wait for the user to approve by moving cards to To do. While working, card_move your card to Doing when you start it and card_done with a one-line summary when it is finished. Keep card titles stable so the board can track them.";

// The conductor role: orchestrate the fleet, do not implement. Single line, free
// of cmd.exe metacharacters so it survives the cmd /c launch path.
const CONDUCTOR_LAWS =
  "You are the CONDUCTOR of a Maestro agent fleet, not a worker. Do NOT write code or do tasks yourself. Orchestrate through the maestro MCP tools. When the user gives you a goal: call board_get, break the goal into cards with card_add, then spawn worker agents with agent_spawn and hand each worker a specific card with fleet_send. Track progress with fleet_status and agent_output, read a worker screen when it looks stuck, move cards with card_move, and mark card_done when a worker reports finished. Keep every worker busy and the board current until the goal is complete. Spawn more workers if there is idle capacity and pending work.";

const enc = new TextEncoder();

const RESTART_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
const KILL_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const SEARCH_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
const MAX_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
// A filled dot — the record button; the ".rec" class pulses it red while active.
const REC_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>';

function buildPaneEl(
  id: string,
  name: string,
  _sub: string,
  badge: string,
  _color: string,
): HTMLElement {
  const el = document.createElement("section");
  el.className = "pane";
  el.dataset.id = id;
  // Slim draggable title bar: status dot · editable name · CLI badge · controls.
  // Controls keep their data-* attributes so the existing wiring in createAgent
  // still binds. `[data-drag]` on the bar is the canvas move handle.
  el.innerHTML = `
    <div class="pane-bar" data-drag>
      <span class="pb-dot"></span>
      <span class="pb-name pane-name">${name}</span>
      <span class="pb-cli">${badge}</span>
      <span class="pb-sp"></span>
      <div class="pb-ctrls ctrls">
        <button class="pctrl" data-search aria-label="Search output">${SEARCH_SVG}</button>
        <button class="pctrl rec-btn" data-record aria-label="Record session">${REC_SVG}</button>
        <button class="pctrl" data-max aria-label="Focus pane">${MAX_SVG}</button>
        <button class="pctrl" data-restart aria-label="Restart agent">${RESTART_SVG}</button>
        <button class="pctrl danger" data-kill aria-label="Kill agent (tree)">${KILL_SVG}</button>
      </div>
    </div>
    <div class="pane-find" data-find hidden>
      <input class="pane-find-in" data-find-in type="text" placeholder="Find in output…" spellcheck="false" />
      <span class="pane-find-count" data-find-count></span>
      <button class="pane-find-btn" data-find-prev aria-label="Previous match">&#8249;</button>
      <button class="pane-find-btn" data-find-next aria-label="Next match">&#8250;</button>
      <button class="pane-find-btn" data-find-close aria-label="Close search">${KILL_SVG}</button>
    </div>
    <div class="term-host" data-host></div>`;
  return el;
}

export function setStatus(p: Pane, text: string, cls: "" | "run" | "err" | "wait") {
  const s = p.el.querySelector<HTMLElement>("[data-status]");
  if (s) {
    s.textContent = text;
    s.className = "pane-stat" + (cls ? " " + cls : "");
  }
  p.el.classList.toggle("err", cls === "err");
  p.el.classList.toggle("run", cls === "run");
}

// Mount a pane immediately (status "queued…"); return a thunk that boots the
// real process. Splitting mount from boot lets the caller throttle booting so a
// big fleet doesn't spike the CPU all at once.
// When `restore` is true the pane is mounted in a STOPPED state (no PTY spawn) —
// session restore uses this so reopening doesn't auto-launch a heavy fleet.
// `attach` re-binds an ALREADY-RUNNING agent (tab detached from another window):
// the pane keeps the original agent id and the thunk calls pty_attach instead
// of spawning a new process.
export function createAgent(
  ws: Workspace,
  spec: AgentSpec,
  restore = false,
  attach?: { id: string; spawnedAt: number | null },
): () => Promise<void> {
  // Make the (sized) workspace grid visible BEFORE mounting xterm, otherwise
  // fit() measures a display:none container as 0×0 and ConPTY paints the prompt
  // at the wrong size (blank pane).
  onShowWorkspace();
  const id = attach?.id ?? newId();
  const sub = spec.cwd ? basename(spec.cwd) : "";
  const el = buildPaneEl(id, spec.name, sub, spec.badge, spec.color);
  ws.gridEl.insertBefore(el, ws.gridEl.lastElementChild); // before the spawn tile

  const host = el.querySelector<HTMLElement>("[data-host]")!;
  const term = mountTerminal(
    host,
    (data) => {
      // Always forward keystrokes AND xterm's automatic answers (e.g. the ConPTY
      // cursor-position-report reply that unblocks the very first render) as long
      // as the pane still exists — never gate on `running`, or the early reply is
      // dropped and ConPTY stalls (blank pane).
      if (ws.panes.has(id)) void sendInput(id, data).catch(() => {});
      pane.lastInputAt = Date.now();
      clearAttention(pane); // the user is interacting → not waiting on them
    },
    (cols, rows) => {
      if (ws.panes.has(id)) void resizePty(id, cols, rows).catch(() => {});
    },
    { openLink: (url) => void openExternal(url).catch(() => {}), fontSize: getTermFontSize() },
  );

  // The persona name owns the title bar now; surface the terminal's own title
  // as a hover tooltip instead of overwriting the name.
  term.onTitleChange((title) => {
    if (title.trim()) el.title = title;
  });

  const pane: Pane = { id, el, term, running: false, spawnedAt: null, lastOutputAt: 0, lastInputAt: 0, attention: false, attentionClearedAt: 0, attentionNotified: false, color: spec.color, spec };
  ws.panes.set(id, pane);
  ws.bcastSelected.add(id);
  layoutGrid(ws);
  onUpdateCount();

  // A restored pane is parked as "stopped" — no PTY is spawned until the user
  // hits ⟳ (which recreates the pane with restore=false → boots normally).
  if (restore) {
    setStatus(pane, "stopped", "");
    el.classList.add("stopped"); // dims the parked pane (cleared on boot)
    term.write(enc.encode("\r\n\x1b[90m  [stopped — click ⟳ to resume]\x1b[0m\r\n"));
  }

  el.querySelector("[data-kill]")?.addEventListener("click", () => void removeAgent(ws, id));
  el.querySelector("[data-record]")?.addEventListener("click", () => void toggleRecord(ws, pane));
  el.querySelector("[data-restart]")?.addEventListener("click", async () => {
    await removeAgent(ws, id);
    await createAgent(ws, spec)();
  });
  el.querySelector("[data-max]")?.addEventListener("click", () => toggleMax(ws, pane));
  el.querySelector<HTMLElement>("[data-drag]")?.addEventListener("dblclick", (e) => {
    const tgt = e.target as HTMLElement;
    if (tgt.closest(".pctrl") || tgt.closest(".pb-name")) return; // buttons + rename aren't focus triggers
    toggleMax(ws, pane);
  });
  onWirePaneSearch(pane);
  wirePaneDrag(ws, pane);
  wirePaneRename(ws, pane);
  // Clicking / focusing into a flagged pane means the user is now looking at it.
  el.addEventListener("pointerdown", () => clearAttention(pane));
  el.addEventListener("focusin", () => clearAttention(pane));

  saveSession();

  // Detach hand-off: the agent is already alive in the backend — just point
  // its output at this window. The backend replays buffered scrollback first.
  if (attach) {
    return async () => {
      if (!ws.panes.has(id)) return;
      const { cols, rows } = term.fit();
      try {
        await attachPty(id, (bytes) => {
          pane.lastOutputAt = Date.now();
          if (pane.attention) clearAttention(pane); // agent is producing output again
          if (ws.panes.has(id)) term.write(bytes);
        });
        pane.running = true;
        pane.spawnedAt = attach.spawnedAt ?? Date.now();
        pane.lastOutputAt = Date.now();
        setStatus(pane, "running", "run");
        onUpdateCount();
        void resizePty(id, cols, rows).catch(() => {});
      } catch {
        // Died between hand-off and attach — its pty-exit fired before we
        // were listening, so park it the way a normal exit would.
        pane.running = false;
        setStatus(pane, "exited", "");
        onUpdateCount();
      }
    };
  }

  return async () => {
    if (!ws.panes.has(id)) return; // killed before its turn to boot
    const { cols, rows } = term.fit();
    try {
      // Isolated agents get their own worktree+branch; point the PTY cwd there.
      let cwd = spec.cwd;
      if (ws.isolated && ws.repoRoot && !spec.worktree) {
        try {
          spec.branch = branchName(spec.name, id.slice(-6));
          spec.worktree = await worktreeAdd(ws.repoRoot, spec.branch);
          cwd = spec.worktree;
          const subEl = el.querySelector<HTMLElement>("[data-sub]");
          if (subEl) subEl.textContent = spec.branch;
          saveSession();
        } catch (e) {
          term.write(enc.encode(`\r\n\x1b[33m[worktree failed, using project dir: ${onErrMsg(e)}]\x1b[0m\r\n`));
        }
      } else if (spec.worktree) {
        cwd = spec.worktree;
      }
      // Enforce Maestro's protocol at the system-prompt level so a Claude agent
      // MUST follow it (not a soft MCP hint, not a button). A conductor gets the
      // orchestration prompt; every other Claude gets the plan-first worker one.
      // Only claude exposes --append-system-prompt; other CLIs still get the MCP
      // tools + server instructions. New array — never mutate spec.args, or a
      // restart would append the flag again and again.
      const laws = spec.role === "conductor" ? CONDUCTOR_LAWS : MAESTRO_LAWS;
      const args =
        spec.badge === "claude" ? [...spec.args, "--append-system-prompt", laws] : spec.args;
      // Resolve npm/script CLIs (claude, codex, …) through cmd.exe /c so Windows
      // can actually launch them — see launchSpec.
      const launch = launchSpec(spec.program, args);
      // Identity for the child process: maestro-mcp uses MAESTRO_AGENT to
      // stamp who moved/finished a board card (see mcp/src/server.ts).
      const envPairs: Array<[string, string]> = [
        ["MAESTRO_AGENT", spec.name],
        ["MAESTRO_WORKSPACE", cwd ?? ""],
      ];
      await spawnPty(id, launch.program, launch.args, cwd, cols, rows, envPairs, (bytes) => {
        pane.lastOutputAt = Date.now();
        if (pane.attention) clearAttention(pane); // agent is producing output again
        // After a tab detach this xterm is disposed but the PTY lives on (the
        // new window owns it) — never write into a dropped pane.
        if (ws.panes.has(id)) term.write(bytes);
      });
      pane.running = true;
      pane.spawnedAt = Date.now();
      pane.lastOutputAt = Date.now();
      setStatus(pane, "running", "run");
      onUpdateCount();
      // Re-fit once the grid layout has settled; correct the PTY size if it moved.
      requestAnimationFrame(() => {
        const s = term.fit();
        if (s.cols !== cols || s.rows !== rows) void resizePty(id, s.cols, s.rows);
      });
    } catch (e) {
      setStatus(pane, "spawn failed", "err");
      term.write(enc.encode(`\r\n\x1b[31m[spawn failed: ${onErrMsg(e)}]\x1b[0m\r\n`));
    }
  };
}

export async function removeAgent(ws: Workspace, id: string) {
  const p = ws.panes.get(id);
  if (!p) return;
  if (p.recording) await stopRecording(p); // flush the recording before the PTY dies
  try {
    await killPty(id);
  } catch {
    /* ignore */
  }
  p.term.dispose();
  p.el.remove();
  ws.panes.delete(id);
  layoutGrid(ws);
  onUpdateCount();
  refreshAttnTabs(); // the removed pane may have been the tab's only alert
  saveSession();
}

/* ---------------- session recording (replay) ---------------- */

// Recordings live under the workspace's own .maestro folder so the player can
// list them per project (see openReplays). Path uses forward slashes — Rust's
// Path handles them on Windows and create_dir_all makes the folder.

/** Reflect a pane's REC button state (pulsing dot + label). */
function setRecUi(p: Pane): void {
  const btn = p.el.querySelector<HTMLElement>("[data-record]");
  if (!btn) return;
  const on = !!p.recording;
  btn.classList.toggle("rec", on);
  btn.setAttribute("aria-label", on ? "Stop recording" : "Record session");
  p.el.classList.toggle("recording", on);
}

/** Transient bottom-right toast (reuses the kanban toast style). */
export function paneToast(text: string, onClick?: () => void): void {
  const t = document.createElement("div");
  t.className = "kb-toast";
  t.textContent = text;
  if (onClick) {
    t.style.cursor = "pointer";
    t.addEventListener("click", () => {
      onClick();
      t.remove();
    });
  }
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("on"));
  window.setTimeout(() => {
    t.classList.remove("on");
    window.setTimeout(() => t.remove(), 400);
  }, 5000);
}

/** Stop a pane's recording (flush the file) and reset its UI. Safe to call when
 *  not recording. Returns the finished recording's path (or null). */
export async function stopRecording(p: Pane): Promise<string | null> {
  const path = p.recording;
  if (!path) return null;
  p.recording = undefined;
  setRecUi(p);
  try {
    await recordStop(p.id);
  } catch {
    /* the agent may already be gone — the file was flushed on drop */
  }
  return path;
}

/** Toggle recording for a pane. Start writes to
 *  `<workspace>/.maestro/recordings/<agent>-<epochms>.jsonl`. */
export async function toggleRecord(ws: Workspace, p: Pane): Promise<void> {
  if (p.recording) {
    const path = await stopRecording(p);
    paneToast("Recording saved — click to replay", () => {
      if (path) openReplays(ws, path);
    });
    return;
  }
  if (!p.running) {
    paneToast("Agent isn't running — nothing to record");
    return;
  }
  const dir = ws.dir ?? p.spec.cwd;
  if (!dir) {
    paneToast("Open a project folder before recording");
    return;
  }
  const safe = (p.spec.name || "agent").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40);
  const path = `${dir}/${REC_DIR_REL}/${safe}-${Date.now()}.jsonl`;
  try {
    await recordStart(p.id, path);
    p.recording = path;
    setRecUi(p);
  } catch (e) {
    paneToast(`Couldn't start recording: ${onErrMsg(e)}`);
  }
}

/* ---------------- attention ---------------- */
// Heuristic "agent needs you": a RUNNING pane that produced output recently and
// then went silent is probably waiting at a prompt for the user. We flag it,
// light up the pill + tab, and (if the window is in the background) fire one OS
// notification. The flag clears when the user types/clicks into the pane or the
// agent starts producing output again. attentionClearedAt stops a quiet shell
// prompt from re-flagging forever: only a NEW burst of output (after the clear)
// that then goes silent can flag again.
const ATTN_SILENCE_MS = 10_000; // output, then this much quiet ⇒ probably waiting

/** Drop a pane's attention flag and restore its normal pill/tab styling. */
export function clearAttention(pane: Pane) {
  if (!pane.attention) return;
  pane.attention = false;
  pane.attentionNotified = false;
  pane.attentionClearedAt = Date.now();
  pane.el.classList.remove("attention");
  // Let the next tick re-derive the run/idle status; set a sane default now.
  setStatus(pane, pane.running ? "running" : "idle", pane.running ? "run" : "");
  refreshAttnTabs();
}

/** Raise a pane's attention flag (pill + tab + optional OS notification). */
function setAttention(pane: Pane, ws: Workspace) {
  if (pane.attention) return;
  pane.attention = true;
  pane.el.classList.add("attention");
  setStatus(pane, "needs you", "wait");
  refreshAttnTabs();
  // Notify only while the window is unattended, once per flag.
  if (!pane.attentionNotified && (document.hidden || !document.hasFocus())) {
    pane.attentionNotified = true;
    void notify(`${pane.spec.name} needs you`, ws.name).catch(() => {});
  }
}

/** Tab dot turns amber when any of its panes is asking for attention. */
function refreshAttnTabs() {
  for (const w of workspaces.values()) {
    const want = [...w.panes.values()].some((p) => p.attention);
    w.tabEl.classList.toggle("attn", want);
  }
}

/** Per-tick attention sweep. Cheap no-op when nothing is running. */
export function updateAttention(now: number) {
  for (const w of workspaces.values())
    for (const pane of w.panes.values()) {
      if (!pane.running || pane.attention) continue;
      // Flag when: had output, that output is now stale, and it arrived AFTER
      // both the last user input and the last clear (so a parked prompt that
      // we already dismissed can't immediately re-flag).
      if (
        pane.lastOutputAt > 0 &&
        now - pane.lastOutputAt > ATTN_SILENCE_MS &&
        pane.lastOutputAt > pane.lastInputAt &&
        pane.lastOutputAt > pane.attentionClearedAt
      ) {
        setAttention(pane, w);
      }
    }
}
