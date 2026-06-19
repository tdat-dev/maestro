/* Dock — a permanent icon rail on the right edge of the workspace that toggles
 * slide-in tool panels (Kanban, Pomodoro, Diff). One home for the side tools so
 * they're always one click (or one shortcut) away instead of buried in the top
 * bar. The rail markup lives in index.html; the sliding panel is built here.
 *
 * Each tool is a small controller (mount/show/hide/setContext) — see kanban.ts,
 * pomodoro.ts, diffview.ts. The dock owns layout, focus, and the active tab. */

import { createKanban } from "./kanban";
import { createPomodoro } from "./pomodoro";
import { createDiffView } from "./diffview";
import type { DockContext } from "./dockstore";

export type ToolId = "kanban" | "pomodoro" | "diff";

interface ToolController {
  mount(body: HTMLElement, actions: HTMLElement): void;
  show?(): void;
  hide?(): void;
  setContext?(ctx: DockContext | null): void;
  attachBadge?(button: HTMLElement): void;
}

const TITLES: Record<ToolId, string> = {
  kanban: "Board",
  pomodoro: "Pomodoro",
  diff: "Changes",
};

let panel: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let active: ToolId | null = null;

const tools = {} as Record<ToolId, ToolController>;
const bodies = {} as Record<ToolId, HTMLElement>;
const actionGroups = {} as Record<ToolId, HTMLElement>;

function railBtn(id: ToolId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.dr-btn[data-tool="${id}"]`);
}

export function dockIsOpen(): boolean {
  return active !== null;
}

export function dockOpen(id: ToolId) {
  if (!panel) return;
  active = id;
  panel.classList.add("open");
  panel.dataset.tool = id;
  panel.setAttribute("aria-hidden", "false");
  if (titleEl) titleEl.textContent = TITLES[id];
  (["kanban", "pomodoro", "diff"] as ToolId[]).forEach((t) => {
    bodies[t].hidden = t !== id;
    actionGroups[t].hidden = t !== id;
    railBtn(t)?.classList.toggle("on", t === id);
    railBtn(t)?.setAttribute("aria-selected", String(t === id));
  });
  tools[id].show?.();
}

export function dockClose() {
  if (!panel || active === null) return;
  tools[active].hide?.();
  railBtn(active)?.classList.remove("on");
  railBtn(active)?.setAttribute("aria-selected", "false");
  active = null;
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
}

export function dockToggle(id: ToolId) {
  if (active === id) dockClose();
  else dockOpen(id);
}

/** Active workspace changed (or went home). Every tool re-scopes its state. */
export function dockSetContext(ctx: DockContext | null) {
  // May be called during early workspace restore, before initDock() runs.
  (["kanban", "pomodoro", "diff"] as ToolId[]).forEach((t) =>
    tools[t]?.setContext?.(ctx),
  );
}

export function initDock() {
  const app = document.getElementById("app");
  if (!app) return;

  // Build the sliding panel (rail buttons are static in index.html).
  panel = document.createElement("aside");
  panel.className = "dock-panel";
  panel.id = "dockPanel";
  panel.setAttribute("aria-hidden", "true");
  panel.innerHTML =
    `<header class="dp-head">` +
    `<span class="dp-title"></span>` +
    `<div class="dp-actions"></div>` +
    `<button class="dp-close" aria-label="Close panel" title="Close (Esc)"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` +
    `</header>` +
    `<div class="dp-bodies"></div>`;
  app.appendChild(panel);

  titleEl = panel.querySelector(".dp-title");
  const bodiesHost = panel.querySelector(".dp-bodies") as HTMLElement;
  const actionsHost = panel.querySelector(".dp-actions") as HTMLElement;

  tools.kanban = createKanban();
  tools.pomodoro = createPomodoro();
  tools.diff = createDiffView();

  (["kanban", "pomodoro", "diff"] as ToolId[]).forEach((id) => {
    const body = document.createElement("div");
    body.className = `dp-body dp-${id}`;
    body.hidden = true;
    bodiesHost.appendChild(body);
    bodies[id] = body;

    const group = document.createElement("div");
    group.className = "dp-actgrp";
    group.hidden = true;
    actionsHost.appendChild(group);
    actionGroups[id] = group;

    tools[id].mount(body, group);

    railBtn(id)?.addEventListener("click", () => dockToggle(id));
  });

  // Live timer badge on the pomodoro rail button.
  const pomoBtn = railBtn("pomodoro");
  if (pomoBtn) tools.pomodoro.attachBadge?.(pomoBtn);

  panel.querySelector(".dp-close")?.addEventListener("click", dockClose);

  // Keep the panel's bottom edge pinned above the broadcast bar (its height can
  // shift with font size). A ResizeObserver also fires once the app view first
  // gains a size, so this works even though .app is hidden on the home screen.
  const bcast = document.getElementById("bcast");
  if (bcast && "ResizeObserver" in window) {
    const ro = new ResizeObserver(() => {
      app.style.setProperty("--bcast-h", `${bcast.offsetHeight}px`);
    });
    ro.observe(bcast);
  }

  // Esc closes the panel — but not while typing in one of its fields (let the
  // field handle Esc), and not when a modal backdrop is up (those own Esc).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || active === null) return;
    if (document.querySelector(".backdrop.open")) return;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && panel?.contains(ae)) return;
    e.preventDefault();
    dockClose();
  });
}
