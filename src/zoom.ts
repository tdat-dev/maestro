// Density zoom for the canvas. Four tiled panes on a 1080p screen leave each
// terminal ~360px tall, and the global font size is one number shared by every
// workspace — so a fleet that fits is unreadable and a fleet that reads doesn't
// fit. Zoom is the per-workspace escape hatch: it scales the EFFECTIVE font
// size and the panes re-fit their cols/rows around it.
//
// Deliberately not a CSS transform. Scaling the pane visually would blur the
// glyphs (they are rasterised at the old size) and would leave the PTY at the
// old cols/rows, so the CLI would keep drawing to a grid that no longer matches
// what is on screen. Changing the font size and refitting keeps every glyph
// crisp and keeps the PTY honest.
//
// Storage helpers aside, this module is pure — unit-tested in zoom.test.ts.

import { type Workspace } from "./panetypes";
import { getTermFontSize } from "./settings";

export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

/** Font sizes xterm still renders legibly; the effective size is held here no
 *  matter what the multiplier works out to. */
export const FONT_MIN = 8;
export const FONT_MAX = 32;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}

/** One notch in or out. Rounded to the step so a wheel-then-keyboard mix can't
 *  leave the zoom on an odd fraction that never returns to a clean 100%. */
export function stepZoom(z: number, dir: 1 | -1): number {
  const steps = Math.round(clampZoom(z) / ZOOM_STEP) + dir;
  return clampZoom(steps * ZOOM_STEP);
}

/** The font size a pane should actually render at. */
export function effectiveFont(base: number, zoom: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(base * clampZoom(zoom))));
}

/** "100%" — what the canvas control shows. */
export function zoomLabel(z: number): string {
  return `${Math.round(clampZoom(z) * 100)}%`;
}

/**
 * Whether auto-fit's row floor still applies at this zoom.
 *
 * Auto-fit shrinks the font by up to AUTO_FIT_DROP px to keep PANE_MIN_ROWS
 * visible in a cramped tile (see commit bb959d2, which capped the drop after an
 * uncapped version shrank text to unreadable). That nudge exists to guess what
 * the user wants when they haven't said. Once they zoom they HAVE said, and the
 * two would fight: zoom in 20%, auto-fit takes 4px straight back off. So user
 * intent wins and the floor stands down — accepting fewer rows is the whole
 * point of zooming in.
 */
export function autoFitRows(floor: number, zoom: number): number {
  return clampZoom(zoom) === 1 ? floor : 0;
}

const key = (ws: Workspace) => `maestro.canvasZoom.${ws.dir ?? ws.id}`;

export function getZoom(ws: Workspace): number {
  const raw = localStorage.getItem(key(ws));
  return raw === null ? 1 : clampZoom(Number(raw));
}

export function setZoom(ws: Workspace, z: number): number {
  const next = clampZoom(z);
  try {
    localStorage.setItem(key(ws), String(next));
  } catch {
    /* quota — the zoom just won't survive a restart */
  }
  return next;
}

/** The font size a pane in `ws` should render at: the global setting, zoomed.
 *  `bump` is for the focus stage, which reads two sizes bigger. Every caller
 *  that sets a pane's font goes through here — a path that used the raw
 *  setting would snap that pane back to 100% behind the user's back. */
export function paneFont(ws: Workspace, bump = 0): number {
  return effectiveFont(getTermFontSize() + bump, getZoom(ws));
}
