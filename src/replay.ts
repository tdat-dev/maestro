// Session replay player: load a recorded .jsonl of timestamped terminal frames
// and play them back into a throwaway terminal, with seek/speed. Split from
// main.ts; the few main-side helpers (toast, error formatting, settings-close)
// are injected. REC_DIR_REL is exported so the recording writer can share it.

import { mountTerminal, type TerminalHandle } from "./terminal";
import { recordRead, fsReadDir, fsDelete } from "./ipc";
import { getTermFontSize } from "./settings";
import { activeWs } from "./appstate";
import { type Workspace } from "./panetypes";

export const REC_DIR_REL = ".maestro/recordings";

let onToast: (text: string, onClick?: () => void) => void = () => {};
let onErrMsg: (e: unknown) => string = (e) => String(e);
let onCloseSettings: () => void = () => {};
export function configureReplay(deps: {
  paneToast: (text: string, onClick?: () => void) => void;
  errMsg: (e: unknown) => string;
  closeSettings: () => void;
}): void {
  onToast = deps.paneToast;
  onErrMsg = deps.errMsg;
  onCloseSettings = deps.closeSettings;
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface RecFrame { t: number; d: string }
interface RecMeta { name: string; path: string; agent: string; at: number; size: number }

const replayModal = document.getElementById("replayModal") as HTMLElement | null;

// Player state. A recording is a list of timestamped frames; playback advances a
// virtual clock and writes every frame whose time has passed. Seeking backward
// resets the terminal and re-writes from the start (ANSI is stateful), so the
// replayed screen is always exactly what the agent showed at that moment.
let rplTerm: TerminalHandle | null = null;
let rplFrames: RecFrame[] = [];
let rplDur = 0; // total ms (last frame)
let rplVt = 0; // current virtual time (ms)
let rplIdx = 0; // next frame to emit
let rplPlaying = false;
let rplSpeed = 1;
let rplRaf = 0;
let rplLastReal = 0;
let rplSeeking = false; // user is dragging the timeline

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

/** Parse a recording's agent name + start time from its filename. */
function parseRecName(file: string): { agent: string; at: number } {
  const base = file.replace(/\.jsonl$/i, "");
  const m = base.match(/^(.*)-(\d{10,})$/);
  return m ? { agent: m[1], at: Number(m[2]) } : { agent: base, at: 0 };
}

function b64ToBytes(d: string): Uint8Array {
  const bin = atob(d);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Render the terminal to virtual time `target` (ms). Rewinds if seeking back. */
function rplRender(target: number): void {
  if (!rplTerm) return;
  if (target < rplVt) {
    rplTerm.reset();
    rplIdx = 0;
    rplVt = 0;
  }
  while (rplIdx < rplFrames.length && rplFrames[rplIdx].t <= target) {
    rplTerm.write(b64ToBytes(rplFrames[rplIdx].d));
    rplIdx++;
  }
  rplVt = target;
  const seek = document.getElementById("replaySeek") as HTMLInputElement | null;
  const time = document.getElementById("replayTime");
  if (seek && !rplSeeking) seek.value = String(rplDur > 0 ? Math.round((rplVt / rplDur) * 1000) : 0);
  if (time) time.textContent = `${fmtClock(rplVt)} / ${fmtClock(rplDur)}`;
}

function rplSetPlaying(on: boolean): void {
  rplPlaying = on;
  document.getElementById("replayPlay")?.classList.toggle("playing", on);
  if (on) {
    rplLastReal = performance.now();
    rplTick();
  } else if (rplRaf) {
    cancelAnimationFrame(rplRaf);
    rplRaf = 0;
  }
}

function rplTick(): void {
  if (!rplPlaying) return;
  const now = performance.now();
  const next = Math.min(rplVt + (now - rplLastReal) * rplSpeed, rplDur);
  rplLastReal = now;
  rplRender(next);
  if (rplVt >= rplDur) {
    rplSetPlaying(false); // reached the end
    return;
  }
  rplRaf = requestAnimationFrame(rplTick);
}

/** Tear down the player terminal + loop (back to list, or modal close). */
function rplTeardown(): void {
  rplSetPlaying(false);
  rplTerm?.dispose();
  rplTerm = null;
  rplFrames = [];
  rplDur = rplVt = rplIdx = 0;
}

/** Show the list view (default) vs the player view. */
function rplShowList(list: boolean): void {
  const listEl = document.getElementById("replayList");
  const player = document.getElementById("replayPlayer");
  const back = document.getElementById("replayBack");
  const crumb = document.getElementById("replayCrumb");
  if (listEl) listEl.hidden = !list;
  if (player) player.hidden = list;
  if (back) back.hidden = list;
  if (list && crumb) crumb.textContent = "";
}

/** Load a recording file and start the player. */
async function rplOpen(path: string, label: string): Promise<void> {
  const host = document.getElementById("replayTerm");
  if (!host) return;
  rplTeardown();
  host.replaceChildren();
  let text: string;
  try {
    text = await recordRead(path);
  } catch (e) {
    onToast(`Couldn't open recording: ${onErrMsg(e)}`);
    return;
  }
  rplFrames = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    try {
      const o = JSON.parse(s);
      if (typeof o.t === "number" && typeof o.d === "string") rplFrames.push({ t: o.t, d: o.d });
    } catch {
      /* header line or a truncated tail — skip */
    }
  }
  rplDur = rplFrames.length ? rplFrames[rplFrames.length - 1].t : 0;
  rplShowList(false);
  const crumb = document.getElementById("replayCrumb");
  if (crumb) crumb.textContent = label;
  rplTerm = mountTerminal(host, () => {}, () => {}, { fontSize: getTermFontSize() });
  rplRender(0);
  rplSetPlaying(true); // autoplay from the top
}

/** List recordings for a workspace, newest first. */
async function rplList(dir: string): Promise<RecMeta[]> {
  let entries;
  try {
    entries = await fsReadDir(dir, REC_DIR_REL);
  } catch {
    return []; // no recordings folder yet
  }
  return entries
    .filter((e) => !e.is_dir && /\.jsonl$/i.test(e.name))
    .map((e) => ({ name: e.name, path: `${dir}/${REC_DIR_REL}/${e.name}`, ...parseRecName(e.name), size: e.size }))
    .sort((a, b) => b.at - a.at);
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function renderReplayList(dir: string): Promise<void> {
  const listEl = document.getElementById("replayList");
  const empty = document.getElementById("replayEmpty");
  if (!listEl) return;
  const recs = await rplList(dir);
  listEl.replaceChildren();
  if (empty) empty.hidden = recs.length > 0;
  for (const r of recs) {
    const when = r.at ? new Date(r.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    const row = document.createElement("div");
    row.className = "replay-row";
    row.innerHTML =
      `<span class="replay-rl"><b>${escHtml(r.agent)}</b><span>${escHtml(when)}</span></span>` +
      `<span class="replay-rdur">${escHtml(fmtSize(r.size))}</span>` +
      `<button class="replay-rdel" aria-label="Delete recording">✕</button>`;
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".replay-rdel")) return;
      void rplOpen(r.path, `${r.agent} · ${when}`);
    });
    row.querySelector(".replay-rdel")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await fsDelete(dir, `${REC_DIR_REL}/${r.name}`);
      } catch { /* ignore */ }
      void renderReplayList(dir);
    });
    listEl.appendChild(row);
  }
}

/** Open the replays modal for a workspace. If `focusPath` is given, jump
 *  straight into that recording (used by the "saved" toast). */
export function openReplays(ws: Workspace, focusPath?: string): void {
  if (!replayModal) return;
  const dir = ws.dir ?? ws.panes.values().next().value?.spec.cwd ?? null;
  rplShowList(true);
  void renderReplayList(dir ?? "");
  replayModal.classList.add("open");
  if (focusPath) {
    const { agent, at } = parseRecName(focusPath.split(/[\\/]/).pop() ?? "");
    const when = at ? new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    void rplOpen(focusPath, `${agent} · ${when}`);
  }
}

function closeReplays(): void {
  rplTeardown();
  replayModal?.classList.remove("open");
}

/** Wire the replay modal's controls. Call once at startup. */
export function initReplay(): void {
  document.getElementById("setOpenReplays")?.addEventListener("click", () => {
    onCloseSettings();
    if (activeWs) openReplays(activeWs);
  });
  document.getElementById("replayClose")?.addEventListener("click", closeReplays);
  document.getElementById("replayCloseBtn")?.addEventListener("click", closeReplays);
  document.getElementById("replayBack")?.addEventListener("click", () => {
    rplTeardown();
    rplShowList(true);
  });
  replayModal?.addEventListener("mousedown", (e) => {
    if (e.target === replayModal) closeReplays();
  });
  document.getElementById("replayPlay")?.addEventListener("click", () => {
    if (!rplTerm) return;
    if (rplVt >= rplDur && !rplPlaying) rplRender(0); // replay from the top
    rplSetPlaying(!rplPlaying);
  });
  document.getElementById("replaySpeed")?.addEventListener("change", (e) => {
    rplSpeed = Number((e.target as HTMLSelectElement).value) || 1;
  });
  const seek = document.getElementById("replaySeek") as HTMLInputElement | null;
  seek?.addEventListener("input", () => {
    rplSeeking = true;
    rplRender(rplDur > 0 ? (Number(seek.value) / 1000) * rplDur : 0);
  });
  seek?.addEventListener("change", () => {
    rplSeeking = false;
    rplLastReal = performance.now(); // resync the clock after the drag
  });
}
