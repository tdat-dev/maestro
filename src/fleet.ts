/* Fleet monitor — a dock tool that lists every agent across ALL workspaces
 * with a live status, so you can see at a glance which agents are working,
 * which are waiting on you, and which have stopped, and jump straight to any
 * of them. Read-only over the pane state main.ts owns (via agentbridge). */

import { fleetSnapshotNow, revealPane, type FleetPane } from "./agentbridge";

export type FleetStatus = "needs" | "active" | "idle" | "stopped";

// Matches main.ts IDLE_MS: no PTY output for this long (while running) ⇒ the
// agent is idle at a prompt rather than actively producing output.
const IDLE_MS = 1200;

/** Classify one pane. `needs` (waiting on you) ranks above everything so it
 *  can't hide; then active (recent output) / idle (quiet) / stopped. */
export function paneStatus(p: FleetPane, now: number): FleetStatus {
  if (!p.running) return "stopped";
  if (p.attention) return "needs";
  return now - p.lastOutputAt <= IDLE_MS ? "active" : "idle";
}

const RANK: Record<FleetStatus, number> = { needs: 0, active: 1, idle: 2, stopped: 3 };

export interface FleetRow extends FleetPane {
  status: FleetStatus;
}

/** Sort for display: needs-you first, then active, idle, stopped; ties keep a
 *  stable name order so the list doesn't jitter between refreshes. */
export function sortFleet(panes: FleetPane[], now: number): FleetRow[] {
  return panes
    .map((p) => ({ ...p, status: paneStatus(p, now) }))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name));
}

/** Count of agents currently waiting on you — the rail badge number. */
export function needsCount(panes: FleetPane[], now: number): number {
  return panes.reduce((n, p) => (paneStatus(p, now) === "needs" ? n + 1 : n), 0);
}

const STATUS_LABEL: Record<FleetStatus, string> = {
  needs: "needs you",
  active: "working",
  idle: "idle",
  stopped: "stopped",
};

const enc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  return h > 0 ? `${h}:${p(m % 60)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

export function createFleet() {
  let root: HTMLElement | null = null;
  let badge: HTMLElement | null = null;
  let timer: number | null = null;

  function render(): void {
    if (!root) return;
    const now = Date.now();
    const rows = sortFleet(fleetSnapshotNow(), now);
    root.replaceChildren();

    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "fleet-empty";
      empty.innerHTML = `<p>No agents running.<br>Spawn a crew to see it here.</p>`;
      root.appendChild(empty);
      return;
    }

    const needs = rows.filter((r) => r.status === "needs").length;
    const active = rows.filter((r) => r.status === "active").length;
    const summary = document.createElement("div");
    summary.className = "fleet-sum";
    summary.innerHTML =
      `<span class="fleet-sum-n">${rows.length}</span> agents` +
      (needs ? ` · <span class="fleet-sum-needs">${needs} need you</span>` : "") +
      (active ? ` · <span class="fleet-sum-active">${active} working</span>` : "");
    root.appendChild(summary);

    const list = document.createElement("div");
    list.className = "fleet-list";
    for (const r of rows) {
      const row = document.createElement("button");
      row.className = `fleet-row st-${r.status}`;
      row.title = "Jump to this agent";
      const uptime = r.spawnedAt && r.running ? fmtUptime(now - r.spawnedAt) : "—";
      row.innerHTML =
        `<span class="fleet-dot" style="--dot:${r.color}"></span>` +
        `<span class="fleet-name">${enc(r.name)}</span>` +
        `<span class="fleet-ws">${enc(r.wsName)}</span>` +
        `<span class="fleet-st">${STATUS_LABEL[r.status]}</span>` +
        `<span class="fleet-up">${uptime}</span>`;
      row.addEventListener("click", () => revealPane(r.wsId, r.id));
      list.appendChild(row);
    }
    root.appendChild(list);
  }

  function refreshBadge(): void {
    if (!badge) return;
    const n = needsCount(fleetSnapshotNow(), Date.now());
    badge.textContent = String(n);
    badge.hidden = n === 0;
  }

  function tick(): void {
    if (root && !root.closest("[hidden]")) render();
    refreshBadge();
  }

  return {
    mount(body: HTMLElement) {
      root = document.createElement("div");
      root.className = "fleet-root";
      body.appendChild(root);
      // One shared interval drives both the open panel and the rail badge, so
      // the badge stays live even when the panel is closed.
      if (timer === null) timer = window.setInterval(tick, 1000);
      render();
    },
    show() {
      render();
    },
    attachBadge(button: HTMLElement) {
      badge = document.createElement("span");
      badge.className = "fleet-badge";
      badge.hidden = true;
      button.appendChild(badge);
      refreshBadge();
    },
  };
}
