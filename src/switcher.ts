/* Fleet switcher — a ⌘K / Ctrl+K command palette that jumps to any agent across
 * every workspace. The real fix for "10 panes open, which one am I on": type a
 * name / CLI / folder, ↑↓ to move, ↵ to jump. Read-only over the pane state
 * main.ts owns (via agentbridge) and reuses the fleet monitor's status verdict
 * so the two never disagree. */

import { fleetSnapshotNow, revealPane, type FleetPane } from "./agentbridge";
import { sortFleet, type FleetRow, type FleetStatus } from "./fleet";
import { basename } from "./workspaces";

/* ---------------- pure helpers (unit-tested) ---------------- */

/** Case-insensitive match across the fields a person types to find an agent:
 *  its name, its workspace, the CLI, and where it works. All words must hit. */
export function matchAgent(p: FleetPane, query: string): boolean {
  const t = query.trim().toLowerCase();
  if (!t) return true;
  const hay = [p.name, p.wsName, p.badge, p.branch, p.cwd]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return t.split(/\s+/).every((w) => hay.includes(w));
}

export function filterFleet(rows: FleetPane[], query: string): FleetPane[] {
  return rows.filter((p) => matchAgent(p, query));
}

const GROUP_LABEL: Record<FleetStatus, string> = {
  needs: "Needs you",
  active: "Running",
  idle: "Idle",
  stopped: "Stopped",
};

export interface SwitcherGroup {
  key: FleetStatus;
  label: string;
  rows: FleetRow[];
}

/** Sorted, filtered rows split into display groups. sortFleet already ranks by
 *  status (needs → active → idle → stopped), so filtering per status keeps that
 *  order; empty groups are dropped. */
export function groupRows(rows: FleetPane[], now: number): SwitcherGroup[] {
  const sorted = sortFleet(rows, now);
  const order: FleetStatus[] = ["needs", "active", "idle", "stopped"];
  const groups: SwitcherGroup[] = [];
  for (const key of order) {
    const gr = sorted.filter((r) => r.status === key);
    if (gr.length) groups.push({ key, label: GROUP_LABEL[key], rows: gr });
  }
  return groups;
}

/** The flat, ordered list that ↑/↓ selection and Ctrl+1..9 quick-jump index
 *  into — the same order the grouped view renders top to bottom. */
export function flatOrder(rows: FleetPane[], now: number): FleetRow[] {
  return groupRows(rows, now).flatMap((g) => g.rows);
}

/** Short "where it works" line: the branch when isolated, else the folder name. */
export function whereLabel(p: FleetPane): string {
  if (p.branch) return p.branch;
  if (p.cwd) return basename(p.cwd);
  return "";
}

/* ---------------- overlay controller ---------------- */

const enc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let back: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;
let footCount: HTMLElement | null = null;
let isOpen = false;
let sel = 0;
let flat: FleetRow[] = [];
let restore: HTMLElement | null = null;

function buildDom(): void {
  if (back) return;
  back = document.createElement("div");
  back.className = "backdrop sw-back";
  back.innerHTML = `
    <div class="sw-panel" role="dialog" aria-modal="true" aria-label="Jump to agent">
      <div class="sw-search">
        <svg class="sw-search-i" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <input class="sw-input" type="text" role="combobox" aria-expanded="true" aria-controls="swList" aria-autocomplete="list"
               placeholder="Jump to an agent…  name, CLI, or folder" spellcheck="false" autocomplete="off" autocapitalize="off">
        <kbd class="sw-kbd sw-esc">Esc</kbd>
      </div>
      <div class="sw-list" id="swList" role="listbox" aria-label="Agents"></div>
      <div class="sw-foot">
        <span class="sw-hint"><kbd class="sw-kbd">↑</kbd><kbd class="sw-kbd">↓</kbd> move</span>
        <span class="sw-hint"><kbd class="sw-kbd">↵</kbd> jump</span>
        <span class="sw-hint"><kbd class="sw-kbd">Ctrl</kbd><kbd class="sw-kbd">1–9</kbd> quick</span>
        <span class="sw-foot-r"><span class="sw-count"></span></span>
      </div>
    </div>`;
  document.body.appendChild(back);
  input = back.querySelector<HTMLInputElement>(".sw-input");
  listEl = back.querySelector<HTMLElement>(".sw-list");
  footCount = back.querySelector<HTMLElement>(".sw-count");

  // Click outside the panel closes.
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) close();
  });
  input!.addEventListener("input", () => {
    sel = 0;
    render();
  });
  input!.addEventListener("keydown", onNavKey);
}

function statusText(s: FleetStatus): string {
  return GROUP_LABEL[s];
}

function render(): void {
  if (!listEl || !input || !footCount) return;
  const now = Date.now();
  const rows = filterFleet(fleetSnapshotNow(), input.value);
  const groups = groupRows(rows, now);
  flat = groups.flatMap((g) => g.rows);
  if (sel >= flat.length) sel = Math.max(0, flat.length - 1);

  listEl.replaceChildren();

  if (!flat.length) {
    const empty = document.createElement("div");
    empty.className = "sw-empty";
    empty.textContent = fleetSnapshotNow().length
      ? "No agent matches that."
      : "No agents yet — spawn a crew to see them here.";
    listEl.appendChild(empty);
    footCount.textContent = "";
    return;
  }

  let i = 0;
  for (const g of groups) {
    const head = document.createElement("div");
    head.className = "sw-group";
    head.textContent = `${g.label} · ${g.rows.length}`;
    listEl.appendChild(head);
    for (const r of g.rows) {
      listEl.appendChild(buildRow(r, i));
      i += 1;
    }
  }
  updateSel();
  footCount.textContent = `${flat.length} agent${flat.length === 1 ? "" : "s"}`;
}

function buildRow(r: FleetRow, i: number): HTMLElement {
  const row = document.createElement("div");
  row.className = `sw-row st-${r.status}`;
  row.id = `sw-opt-${i}`;
  row.setAttribute("role", "option");
  const initial = (r.name.trim()[0] ?? "?").toUpperCase();
  const director = r.role === "conductor" ? `<span class="sw-role">Director</span>` : "";
  const stage = r.onStage ? `<span class="sw-stage">On stage</span>` : "";
  const badge = r.badge ? `<span class="sw-badge">${enc(r.badge)}</span>` : "";
  const where = whereLabel(r);
  const sub =
    `<span class="sw-ws">${enc(r.wsName)}</span>` +
    (where ? `<span class="sw-dotsep">·</span><span class="sw-where">${enc(where)}</span>` : "");
  row.innerHTML =
    `<span class="sw-av" style="background:${r.color}">${enc(initial)}<span class="sw-s st-${r.status}"></span></span>` +
    `<span class="sw-main">` +
    `<span class="sw-top"><span class="sw-name">${enc(r.name)}</span>${director}${badge}${stage}</span>` +
    `<span class="sw-sub">${sub}</span>` +
    `</span>` +
    `<span class="sw-status st-${r.status}">${statusText(r.status)}</span>`;
  row.addEventListener("click", () => jump(i));
  row.addEventListener("mousemove", () => {
    if (sel !== i) {
      sel = i;
      updateSel();
    }
  });
  return row;
}

/** Reflect `sel` onto the rows (aria + class) and keep it in view. */
function updateSel(): void {
  if (!listEl || !input) return;
  const rows = listEl.querySelectorAll<HTMLElement>(".sw-row");
  rows.forEach((el, i) => {
    const on = i === sel;
    el.classList.toggle("cur", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
    if (on) {
      input!.setAttribute("aria-activedescendant", el.id);
      el.scrollIntoView({ block: "nearest" });
    }
  });
}

function onNavKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    close();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (flat.length) {
      sel = (sel + 1) % flat.length;
      updateSel();
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (flat.length) {
      sel = (sel - 1 + flat.length) % flat.length;
      updateSel();
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (flat.length) jump(sel);
  } else if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
    // Quick-jump to the Nth visible agent regardless of where the cursor is.
    e.preventDefault();
    const n = Number(e.key) - 1;
    if (n < flat.length) jump(n);
  }
}

function jump(i: number): void {
  const r = flat[i];
  if (!r) return;
  close();
  revealPane(r.wsId, r.id);
}

export function openSwitcher(): void {
  if (isOpen) return;
  buildDom();
  restore = document.activeElement as HTMLElement | null;
  isOpen = true;
  sel = 0;
  input!.value = "";
  back!.classList.add("open");
  render();
  input!.focus();
}

function close(): void {
  if (!isOpen || !back) return;
  isOpen = false;
  back.classList.remove("open");
  input?.setAttribute("aria-activedescendant", "");
  // Return focus to wherever the person was (usually a terminal), unless the
  // jump already moved focus onto a pane.
  if (restore && document.body.contains(restore)) {
    try {
      restore.focus();
    } catch {
      /* element may be gone */
    }
  }
}

/** Install the global open shortcut (Ctrl/⌘+K). Idempotent-safe wiring lives in
 *  main.ts's single call. Capture phase so it beats xterm's own key handling. */
export function initSwitcher(): void {
  document.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
        // Don't hijack ⌘K while another modal owns the screen.
        if (isOpen) {
          e.preventDefault();
          close();
          return;
        }
        if (document.querySelector(".backdrop.open")) return;
        e.preventDefault();
        e.stopPropagation();
        openSwitcher();
      }
    },
    true,
  );
}
