// Local web dashboard (remote fleet view): serves a JSON snapshot of every
// agent + a text tail of its screen to the phone-facing HTTP page, and relays
// keystrokes/messages from that page back into the right PTY. Split from
// main.ts; reads the fleet via appstate, formats errors via an injected helper.

import { workspaces } from "./appstate";
import { paneStatus } from "./fleet";
import {
  sendInput,
  dashboardStart,
  dashboardStop,
  dashboardStatus,
  dashboardPush,
  onDashboardSend,
} from "./ipc";

// The remote page reads each agent's on-screen text from its xterm buffer; the
// emulator has already collapsed in-place repaints to the current screen.
const DASH_OUTPUT_ROWS = 40;
const DASH_PORT = 8477;

let onErrMsg: (e: unknown) => string = (e) => String(e);
export function configureDashboard(deps: { errMsg: (e: unknown) => string }): void {
  onErrMsg = deps.errMsg;
}

function fmtUptimeShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${m % 60}m` : m > 0 ? `${m}m` : `${s}s`;
}

/** JSON snapshot the dashboard HTTP page renders: the roster plus a recent
 *  plain-text tail of each agent's output so it can be managed, not just seen. */
function fleetSnapshotJson(): string {
  const now = Date.now();
  const agents = [];
  const output: Record<string, string> = {};
  for (const ws of workspaces.values())
    for (const p of ws.panes.values()) {
      agents.push({
        id: p.id,
        name: p.spec.name,
        wsId: ws.id,
        wsName: ws.name,
        status: paneStatus(
          {
            id: p.id, name: p.spec.name, color: p.color, wsId: ws.id, wsName: ws.name,
            running: p.running, attention: p.attention, spawnedAt: p.spawnedAt, lastOutputAt: p.lastOutputAt,
          },
          now,
        ),
        uptime: p.spawnedAt && p.running ? fmtUptimeShort(now - p.spawnedAt) : "",
      });
      const screen = p.term.snapshot(DASH_OUTPUT_ROWS);
      if (screen.trim()) output[p.id] = screen;
    }
  return JSON.stringify({ agents, output });
}

let dashboardOn = false;
function pushDash(): void {
  if (dashboardOn) void dashboardPush(fleetSnapshotJson()).catch(() => {});
}

const dashToggle = document.getElementById("setDashOn") as HTMLInputElement | null;
const dashLan = document.getElementById("setDashLan") as HTMLInputElement | null;
const dashUrl = document.getElementById("setDashUrl");

function paintDash(info: { running: boolean; lan: boolean; urls: string[] }): void {
  dashboardOn = info.running;
  if (dashToggle) dashToggle.checked = info.running;
  if (dashLan) dashLan.checked = info.lan;
  if (dashUrl)
    dashUrl.textContent = info.running
      ? "Open on any device on your network: " + (info.urls.join("  ·  ") || `http://127.0.0.1:${DASH_PORT}`)
      : "Off — turn on to view the fleet from your phone.";
}

async function refreshDash(): Promise<void> {
  try {
    paintDash(await dashboardStatus());
  } catch {
    /* backend not ready */
  }
}
async function applyDash(): Promise<void> {
  const lan = dashLan?.checked ?? false;
  try {
    if (dashToggle?.checked) paintDash(await dashboardStart(DASH_PORT, lan));
    else paintDash(await dashboardStop());
  } catch (e) {
    if (dashUrl) dashUrl.textContent = `Couldn't start on port ${DASH_PORT}: ${onErrMsg(e)}`;
    if (dashToggle) dashToggle.checked = false;
    dashboardOn = false;
  }
}

/** Start the 1s push loop, the inbound key/message relay, and wire the toggles.
 *  Call once at startup. */
export function initDashboard(): void {
  window.setInterval(pushDash, 1000);
  // A message OR a raw key from the dashboard page → deliver into the pane's PTY.
  // `keys` is a raw escape sequence sent as-is (arrows, Enter, Esc, ^C, Tab) so
  // an interactive menu can be driven; `message` is text + Enter.
  void onDashboardSend((body) => {
    try {
      const o = JSON.parse(body) as { paneId?: unknown; message?: unknown; keys?: unknown };
      if (typeof o.paneId !== "string") return;
      let data: string | null = null;
      if (typeof o.keys === "string" && o.keys) data = o.keys;
      else if (typeof o.message === "string" && o.message.trim()) data = o.message + "\r";
      if (data === null) return;
      for (const ws of workspaces.values()) {
        const pane = ws.panes.get(o.paneId);
        if (pane && pane.running) {
          void sendInput(pane.id, data).catch(() => {});
          window.setTimeout(pushDash, 150);
          window.setTimeout(pushDash, 450);
          return;
        }
      }
    } catch {
      /* malformed body — ignore */
    }
  });
  dashToggle?.addEventListener("change", () => void applyDash());
  dashLan?.addEventListener("change", () => {
    if (dashToggle?.checked) void applyDash(); // re-bind on the new interface
  });
  void refreshDash();
}
