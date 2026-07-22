// Canvas orchestration for agent panes: absolute positioning from a per-workspace
// layout map, Tidy tiling, focus stage + avatar rail, and pointer-drag + inline
// rename of the title bar. Split out of main.ts; the two main-side callbacks it
// needs (refresh the broadcast targets, persist the session) are injected via
// configurePaneLayout to avoid a circular import.

import { tileToFit, nextSlot, serializeLayout } from "./canvas";
import { resizePty } from "./ipc";
import { type Pane, type Workspace } from "./panetypes";

let onBcastChange: () => void = () => {};
let onSessionChange: () => void = () => {};
export function configurePaneLayout(deps: { updateBcast: () => void; saveSession: () => void }): void {
  onBcastChange = deps.updateBcast;
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
    ws.gridEl.querySelector(".cloud-rail")?.remove();
  }
  const tile = ws.gridEl.querySelector<HTMLElement>(".tile-spawn");
  if (tile) tile.style.display = ws.panes.size > 0 ? "none" : "";
  applyLayout(ws);
}

export function applyLayout(ws: Workspace): void {
  const area = { width: ws.gridEl.clientWidth || 1280, height: ws.gridEl.clientHeight || 800 };
  for (const [id, p] of ws.panes) {
    let t = ws.layout.get(id);
    if (!t) {
      const slot = nextSlot([...ws.layout.values()], { w: 540, h: 384, gap: 12 }, area);
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

/** Tidy: tile every pane to fill the screen (2→big side by side, 4→2×2, …). */
export function tidyLayout(ws: Workspace): void {
  const area = { width: ws.gridEl.clientWidth, height: ws.gridEl.clientHeight };
  const ids = [...ws.panes.keys()];
  const tiles = tileToFit(ids.length, area);
  ids.forEach((id, i) => ws.layout.set(id, tiles[i]));
  applyLayout(ws);
  requestAnimationFrame(() => {
    for (const p of ws.panes.values()) {
      const s = p.term.fit();
      if (p.running) void resizePty(p.id, s.cols, s.rows).catch(() => {});
    }
  });
}

/* ---------------- pane focus (stage + avatar rail) ---------------- */
// Focus one pane: it fills the stage; the others collapse into a right-edge
// avatar rail (replaces the old maximize that hid every other pane).
export function focusPane(ws: Workspace, pane: Pane): void {
  for (const p of ws.panes.values()) p.el.classList.toggle("focused", p === pane);
  pane.el.style.setProperty("--stg", pane.color); // tints the stage's hue ring
  pane.el.querySelector("[data-max]")?.setAttribute("aria-label", "Back to canvas");
  ws.gridEl.classList.add("has-focus");
  renderRail(ws, pane);
  requestAnimationFrame(() => {
    const s = pane.term.fit();
    if (pane.running) void resizePty(pane.id, s.cols, s.rows).catch(() => {});
    pane.term.focus();
  });
}
export function exitFocus(ws: Workspace): void {
  if (!ws.gridEl.classList.contains("has-focus")) return;
  ws.gridEl.classList.remove("has-focus");
  for (const p of ws.panes.values()) {
    p.el.classList.remove("focused");
    p.el.querySelector("[data-max]")?.setAttribute("aria-label", "Focus pane");
  }
  ws.gridEl.querySelector(".cloud-rail")?.remove();
  requestAnimationFrame(() => {
    for (const p of ws.panes.values()) {
      const s = p.term.fit();
      if (p.running) void resizePty(p.id, s.cols, s.rows).catch(() => {});
    }
  });
}
export function toggleMax(ws: Workspace, pane: Pane): void {
  if (pane.el.classList.contains("focused")) exitFocus(ws);
  else focusPane(ws, pane);
}
// The other panes as a tiny avatar column down the right edge of the stage.
function renderRail(ws: Workspace, focused: Pane): void {
  let rail = ws.gridEl.querySelector<HTMLElement>(".cloud-rail");
  if (!rail) {
    rail = document.createElement("aside");
    rail.className = "cloud-rail";
    ws.gridEl.appendChild(rail);
  }
  const others = [...ws.panes.values()].filter((p) => p !== focused);
  const label = others.length ? `<span class="rail-lbl">Others</span>` : "";
  rail.innerHTML =
    label +
    others
      .map((p) => {
        const s = p.attention ? "attention" : p.running ? "running" : "idle";
        const nm = p.spec.name;
        const letter = (nm.trim()[0] ?? "?").toUpperCase();
        return `<button class="rc" data-id="${p.id}" title="${nm}">
        <span class="av" style="background:${p.color};--hue:${p.color}">${letter}<span class="s ${s}"></span></span>
        <span class="n">${nm}</span></button>`;
      })
      .join("");
  rail.querySelectorAll<HTMLElement>(".rc").forEach((rc) =>
    rc.addEventListener("click", () => {
      const p = rc.dataset.id ? ws.panes.get(rc.dataset.id) : undefined;
      if (p) focusPane(ws, p);
    }),
  );
}

// Free-position a pane by dragging its title bar (Pointer Events — WebView2
// breaks HTML5 DnD). Updates the workspace canvas layout live, persists on
// release. A near-zero drag is a click (leaves focus handling alone).
export function wirePaneDrag(ws: Workspace, pane: Pane): void {
  const handle = pane.el.querySelector<HTMLElement>(".pane-bar");
  if (!handle) return;
  let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, pid = -1;
  handle.addEventListener("pointerdown", (e) => {
    const dt = e.target as HTMLElement;
    if (dt.closest(".pctrl") || dt.closest(".pb-name") || dt.closest("[data-edit]") || dt.isContentEditable) return;
    if (ws.gridEl.classList.contains("has-focus")) return; // no free-drag while focused
    const t = ws.layout.get(pane.id) ?? { x: 0, y: 0, w: pane.el.offsetWidth, h: pane.el.offsetHeight };
    moved = false; pid = e.pointerId; handle.setPointerCapture(pid);
    sx = e.clientX; sy = e.clientY; ox = t.x; oy = t.y;
  });
  handle.addEventListener("pointermove", (e) => {
    if (pid < 0) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 4) { moved = true; pane.el.classList.add("dragging"); }
    if (moved) {
      const t = ws.layout.get(pane.id);
      if (!t) return;
      t.x = Math.max(0, ox + dx); t.y = Math.max(0, oy + dy);
      pane.el.style.left = `${t.x}px`; pane.el.style.top = `${t.y}px`;
    }
  });
  handle.addEventListener("pointerup", () => {
    if (pid < 0) return;
    try { handle.releasePointerCapture(pid); } catch { /* already released */ }
    pid = -1;
    if (moved) { pane.el.classList.remove("dragging"); saveLayout(ws); }
  });
}

// Click the pane's name to rename it (persona → role). Commits on Enter/blur,
// reverts on Escape. The name is the single identity across the pane, the focus
// rail, and MAESTRO_AGENT (applied to future spawns of this pane).
export function wirePaneRename(ws: Workspace, pane: Pane): void {
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
    if (pane.el.classList.contains("focused")) renderRail(ws, pane);
    onBcastChange();
    onSessionChange();
  };
  nameEl.addEventListener("blur", commit);
  nameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); }
    else if (e.key === "Escape") { nameEl.textContent = pane.spec.name; nameEl.blur(); }
  });
}
