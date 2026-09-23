// Canvas orchestration for agent panes: absolute positioning from a per-workspace
// layout map, Tidy tiling, focus stage + avatar rail, and pointer-drag + inline
// rename of the title bar. Split out of main.ts; the two main-side callbacks it
// needs (refresh the broadcast targets, persist the session) are injected via
// configurePaneLayout to avoid a circular import.

import { nextSlot, serializeLayout } from "./canvas";
import { resizePty } from "./ipc";
import { paneFont } from "./zoom";
import { basename } from "./workspaces";
import { type Pane, type Workspace } from "./panetypes";

let onSessionChange: () => void = () => {};
export function configurePaneLayout(deps: { saveSession: () => void }): void {
  onSessionChange = deps.saveSession;
}

export function layoutKey(ws: Workspace): string {
  return `maestro.canvas.${ws.dir ?? ws.id}`;
}
export function saveLayout(ws: Workspace): void {
  localStorage.setItem(layoutKey(ws), serializeLayout(Object.fromEntries(ws.layout)));
}

/** Position/size every pane from the workspace's canvas layout map (a pane with
 *  no entry yet gets a fresh non-overlapping slot), toggle the spawn tile, and
 *  clear a stale focus state (the focused pane was killed/detached). */
export function layoutGrid(ws: Workspace): void {
  if (ws.gridEl.classList.contains("has-focus") && !ws.gridEl.querySelector(".pane.focused")) {
    ws.gridEl.classList.remove("has-focus");
  }
  applyLayout(ws);
}

export function applyLayout(ws: Workspace): void {
  const area = { width: ws.gridEl.clientWidth || 1280, height: ws.gridEl.clientHeight || 800 };
  for (const [id, p] of ws.panes) {
    let t = ws.layout.get(id);
    if (!t) {
      // gap 0: a freshly spawned pane lands flush against its neighbours, the
      // same continuous surface Tidy produces.
      const slot = nextSlot([...ws.layout.values()], { w: 540, h: 384, gap: 0 }, area);
      t = { x: slot.x, y: slot.y, w: 540, h: 384 };
      ws.layout.set(id, t);
    }
    p.el.style.left = `${t.x}px`;
    p.el.style.top = `${t.y}px`;
    p.el.style.width = `${t.w}px`;
    p.el.style.height = `${t.h}px`;
  }
  for (const id of [...ws.layout.keys()]) if (!ws.panes.has(id)) ws.layout.delete(id);
  saveLayout(ws);
}

/* ---------------- pane focus (stage + avatar rail) ---------------- */
// Focus one pane: it fills the stage; the others collapse into a right-edge
// avatar rail (replaces the old maximize that hid every other pane).
export function focusPane(ws: Workspace, pane: Pane, ev?: MouseEvent): void {
  for (const p of ws.panes.values()) p.el.classList.toggle("focused", p === pane);
  pane.el.style.setProperty("--stg", pane.color); // tints the stage's hue ring
  // Identity subtitle on the stage header: workspace · where it works. Only
  // shown while focused (CSS), so the tiled bar stays slim.
  const where = pane.spec.branch || (pane.spec.cwd ? basename(pane.spec.cwd) : "");
  const whereEl = pane.el.querySelector<HTMLElement>("[data-where]");
  if (whereEl) whereEl.textContent = where ? `${ws.name} · ${where}` : ws.name;
  pane.el.querySelector("[data-max]")?.setAttribute("aria-label", "Back to canvas");
  // Grow the zoom out of the click point (the mockup's --ox/--oy), else centre.
  if (ev) {
    const g = ws.gridEl.getBoundingClientRect();
    pane.el.style.setProperty("--ox", `${Math.round(ev.clientX - g.left - 12)}px`);
    pane.el.style.setProperty("--oy", `${Math.round(ev.clientY - g.top - 12)}px`);
  } else {
    pane.el.style.removeProperty("--ox");
    pane.el.style.removeProperty("--oy");
  }
  ws.gridEl.classList.add("has-focus");
  requestAnimationFrame(() => {
    pane.term.setFontSize(paneFont(ws, 2)); // bigger on the stage, still zoomed
    const s = pane.term.fit();
    if (pane.running) void resizePty(pane.id, s.cols, s.rows).catch(() => {});
    pane.term.focus();
  });
}
export function exitFocus(ws: Workspace): void {
  if (!ws.gridEl.classList.contains("has-focus")) return;
  ws.gridEl.classList.remove("has-focus");
  const focused = [...ws.panes.values()].find((p) => p.el.classList.contains("focused"));
  for (const p of ws.panes.values()) {
    p.el.classList.remove("focused");
    p.el.querySelector("[data-max]")?.setAttribute("aria-label", "Focus pane");
  }
  requestAnimationFrame(() => {
    focused?.term.setFontSize(paneFont(ws)); // back to the tiled (zoomed) size
    for (const p of ws.panes.values()) {
      const s = p.term.fit();
      if (p.running) void resizePty(p.id, s.cols, s.rows).catch(() => {});
    }
  });
}
export function toggleMax(ws: Workspace, pane: Pane, ev?: MouseEvent): void {
  // The inbox has no canvas to go back to: the stage always holds one agent.
  if (document.body.classList.contains("inbox-ui")) { if (!pane.el.classList.contains("focused")) focusPane(ws, pane, ev); return; }
  if (pane.el.classList.contains("focused")) exitFocus(ws);
  else focusPane(ws, pane, ev);
}
// Click the pane's name to rename it (persona → role). Commits on Enter/blur,
// reverts on Escape. The name is the single identity across the pane, the focus
// rail, and MAESTRO_AGENT (applied to future spawns of this pane).
export function wirePaneRename(_ws: Workspace, pane: Pane): void {
  const nameEl = pane.el.querySelector<HTMLElement>(".pb-name");
  if (!nameEl) return;
  const startEdit = (e: Event) => {
    e.stopPropagation();
    if (nameEl.isContentEditable) return;
    nameEl.contentEditable = "true";
    nameEl.focus();
    window.getSelection()?.selectAllChildren(nameEl);
  };
  nameEl.addEventListener("click", startEdit);
  // The pencil affordance next to the name triggers the same inline rename.
  pane.el.querySelector<HTMLElement>("[data-edit]")?.addEventListener("click", startEdit);
  const commit = () => {
    if (!nameEl.isContentEditable) return;
    nameEl.contentEditable = "false";
    const v = nameEl.textContent?.trim();
    pane.spec.name = v && v.length ? v : pane.spec.name;
    nameEl.textContent = pane.spec.name;
    onSessionChange();
  };
  nameEl.addEventListener("blur", commit);
  nameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); }
    else if (e.key === "Escape") { nameEl.textContent = pane.spec.name; nameEl.blur(); }
  });
}
