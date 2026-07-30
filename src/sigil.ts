// Fleet sigil — the orrery drawn between the panes. Pure geometry and the
// state→ink mapping; no DOM, no canvas, no clock. sigilcanvas.ts owns the
// pixels, this owns the shape. Unit-tested in sigil.test.ts.
//
// The design rule the whole module answers to: NOTHING here is decorative
// invention. Every number the drawing needs is derived from something real —
// the ring angles from each pane's actual rect, the core's side count from how
// many agents are open, the ink from the status fleet.ts already computes. If
// the layout changes, the sigil changes, because it is a diagram of the layout.

import { type FleetStatus } from "./fleet";
import { type Tile, type Area } from "./canvas";

const TAU = Math.PI * 2;

/** One agent as the sigil sees it: where its pane sits, and how it's doing. */
export interface SigilAgent {
  id: string;
  rect: Tile;
  status: FleetStatus;
}

/** One agent's branch: the spoke angle plus the slice of the middle ring its
 *  pane subtends. `to` is always ≥ `from` (it may exceed TAU — draw as-is). */
export interface Branch {
  id: string;
  status: FleetStatus;
  /** Direction of the pane's centre from the sigil's centre, in canvas radians
   *  (0 = right, +y = down). The node and the spoke sit on this. */
  angle: number;
  from: number;
  to: number;
}

export interface SigilGeom {
  cx: number;
  cy: number;
  /** Outer ruler ring — the still one. */
  rOuter: number;
  /** Middle ring — carries one arc + one node per agent. */
  rMid: number;
  /** Inner ring — the one that breathes. */
  rInner: number;
  /** Core polygon's circumradius. */
  rCore: number;
  /** Sides of the core polygon = agent count (2 reads as a bare line). */
  coreSides: number;
  branches: Branch[];
}

/* ---------------- proportions ---------------- */
// Fractions of the SHORT edge, so the sigil keeps its shape on any window and
// never runs off the top and bottom of a wide one.
const R_OUTER = 0.44;
const R_MID = 0.30;
const R_INNER = 0.155;
const R_CORE = 0.062;

/** Ticks around the outer ring, and how often one is a long (cardinal) tick. */
export const TICKS = 60;
export const TICK_MAJOR_EVERY = 15;

/** Gap left at each end of an agent's arc so two neighbouring arcs read as two
 *  arcs and not one unbroken ring. */
const ARC_INSET = 0.035; // radians ≈ 2°

/** Core polygons stop gaining sides here — past this they're circles anyway,
 *  and the fleet count is legible from the node ring instead. */
const CORE_SIDES_MAX = 12;

/** How many sides the core polygon takes for `n` agents. Below 2 there is no
 *  polygon to draw (1 returns 1 — sigilcanvas draws a dot). */
export function coreSidesFor(n: number): number {
  if (n <= 1) return Math.max(0, n);
  return Math.min(CORE_SIDES_MAX, n);
}

/** Wrap into [0, TAU). */
function norm(a: number): number {
  const m = a % TAU;
  return m < 0 ? m + TAU : m;
}

/** A corner this close to the centre has no direction from it. */
const CORNER_EPS = 0.5; // px

/**
 * The slice of the circle a rect covers as seen from (cx, cy).
 *
 * Two cases, and both of them are the common case rather than trivia:
 *
 *  - The centre STRICTLY inside the rect — one pane filling the canvas. It
 *    subtends everything, and four corner samples can't discover that on their
 *    own (they'd report ~247°), so it's decided by containment instead.
 *
 *  - A corner sitting exactly ON the centre — every tile of a flush 2×2 tidy,
 *    which is the layout this feature was built for. atan2(0, 0) is 0, and that
 *    phantom angle at 0° opened a 180° "gap" that swallowed half the ring: each
 *    quadrant tile came back claiming a hemisphere. Such corners are dropped.
 *
 * Otherwise the span is the complement of the LARGEST gap between the corner
 * angles, which is what gets the ±π wrap right for a rect straddling the -x
 * axis without any special-casing.
 */
export function angularSpan(r: Tile, cx: number, cy: number): { from: number; to: number } {
  const inside = cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h;
  if (inside) return { from: 0, to: TAU };

  const angs = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ]
    .filter(([x, y]) => Math.hypot(x - cx, y - cy) > CORNER_EPS)
    .map(([x, y]) => norm(Math.atan2(y - cy, x - cx)))
    .sort((a, b) => a - b);

  // A rect collapsed onto the centre has no direction either — give it the ring
  // rather than a nonsense sliver.
  if (angs.length < 2) return { from: 0, to: TAU };

  const n = angs.length;
  let gi = 0;
  let widest = -1;
  for (let i = 0; i < n; i++) {
    const gap = norm(angs[(i + 1) % n] - angs[i]);
    if (gap > widest) {
      widest = gap;
      gi = i;
    }
  }
  const from = angs[(gi + 1) % n];
  let to = angs[gi];
  if (to < from) to += TAU;
  return { from, to };
}

/** Full geometry for one frame's worth of agents. Order of `agents` only
 *  matters for the fallback angles below — the shape itself is positional. */
export function sigilGeometry(area: Area, agents: SigilAgent[]): SigilGeom {
  const cx = area.width / 2;
  const cy = area.height / 2;
  const edge = Math.min(area.width, area.height);
  const n = agents.length;

  const branches: Branch[] = agents.map((a, i) => {
    const mx = a.rect.x + a.rect.w / 2;
    const my = a.rect.y + a.rect.h / 2;
    // A pane centred exactly on the sigil (one pane filling the canvas) has no
    // direction to point in. Fall back to an even fan rather than atan2(0,0),
    // which would stack every such agent at angle 0.
    const off = Math.hypot(mx - cx, my - cy);
    const angle = off < 1 ? norm((i / Math.max(1, n)) * TAU - Math.PI / 2) : norm(Math.atan2(my - cy, mx - cx));
    const span = angularSpan(a.rect, cx, cy);
    // Inset both ends, but never past the point where the arc inverts — a
    // sliver of a pane should vanish, not wrap the wrong way round the ring.
    const room = (span.to - span.from) / 2;
    const inset = Math.min(ARC_INSET, room * 0.4);
    return { id: a.id, status: a.status, angle, from: span.from + inset, to: span.to - inset };
  });

  return {
    cx,
    cy,
    rOuter: edge * R_OUTER,
    rMid: edge * R_MID,
    rInner: edge * R_INNER,
    rCore: edge * R_CORE,
    coreSides: coreSidesFor(n),
    branches,
  };
}

/* ---------------- state → ink ---------------- */

/** Which of the four pens a branch draws with. sigilcanvas resolves these to
 *  actual colours, because the base pen flips with the wallpaper's tone. */
export type Pen = "base" | "run" | "needs" | "stopped";

export interface Ink {
  pen: Pen;
  /** Multiplier on the sigil's overall alpha — relative weight, not opacity. */
  weight: number;
  /** Node is a filled disc rather than an open ring. */
  filled: boolean;
  /** A highlight travels out along the spoke. */
  pulse: boolean;
}

const INK: Record<FleetStatus, Ink> = {
  // Producing output: the only status that moves.
  active: { pen: "run", weight: 1, filled: true, pulse: true },
  // Waiting on you: loud but still, so it reads as a held state, not activity.
  needs: { pen: "needs", weight: 1, filled: true, pulse: false },
  // Alive at a prompt.
  idle: { pen: "base", weight: 0.75, filled: false, pulse: false },
  // Dead: greyed and quiet, never invisible — a stopped agent is information.
  stopped: { pen: "stopped", weight: 0.4, filled: false, pulse: false },
};

export function inkFor(status: FleetStatus): Ink {
  return INK[status];
}

/* ---------------- rhythm ---------------- */
// Slow on purpose. The sigil sits under a terminal; anything with a period
// short enough to catch the eye would be competing with the text above it.

export const BREATHE_MS = 6200;
export const CORE_TURN_MS = 120_000;
export const PULSE_MS = 2600;

/** Radius multiplier for the inner ring: ±2%, once every BREATHE_MS. */
export function breathe(t: number): number {
  return 1 + 0.02 * Math.sin((t / BREATHE_MS) * TAU);
}

/** Core polygon's rotation — one turn every two minutes. */
export function coreAngle(t: number): number {
  return ((t % CORE_TURN_MS) / CORE_TURN_MS) * TAU;
}

/** Where an active branch's pulse is, 0 (core) → 1 (node). Offset per index so
 *  four busy agents don't beat in unison. */
export function pulseAt(t: number, index: number): number {
  const p = t / PULSE_MS + index * 0.37;
  return p - Math.floor(p);
}

/* ---------------- how hard it may be seen ---------------- */

/**
 * The sigil's ceiling. It is drawn UNDER the panes, so every stroke competes
 * with terminal glyphs for the same pixels; past this it stops being a
 * background and starts being noise behind text you are trying to read.
 */
export const MAX_ALPHA = 0.24;

/** Map the Settings slider (0…1) onto an alpha that can never exceed the
 *  legibility ceiling, whatever gets passed in. */
export function sigilAlpha(intensity: number): number {
  return Math.min(1, Math.max(0, intensity)) * MAX_ALPHA;
}

/* ---------------- when it may animate ---------------- */

export type TickMode = "off" | "static" | "slow" | "full";

export interface TickEnv {
  /** The workspace's own on/off preference. */
  enabled: boolean;
  /** document.visibilityState !== "hidden". */
  visible: boolean;
  /** This workspace is the one on screen. */
  wsActive: boolean;
  /** The grid is in canvas mode (the only mode the sigil exists in). */
  canvasMode: boolean;
  /** A pane has taken the focus stage — it covers the canvas, so the sigil is
   *  hidden and there is nothing to draw. */
  focusMode: boolean;
  reducedMotion: boolean;
  /** How many agents the workspace holds. Zero means there is no fleet to
   *  diagram, so the loop must not run at all — an empty workspace left open
   *  is the commonest way an idle animation quietly burns a battery. */
  agentCount: number;
  /** Any agent is producing output — the only reason to run at full rate. */
  anyActive: boolean;
}

/**
 * How often (if at all) the sigil should redraw.
 *
 * "off" means the animation loop is CANCELLED, not throttled: an unwatched
 * workspace, a hidden window, or a disabled sigil must cost exactly zero. This
 * matters more here than in most UI — Maestro leaves fleets parked for hours.
 */
export function tickMode(e: TickEnv): TickMode {
  if (!e.enabled || !e.visible || !e.wsActive || !e.canvasMode || e.focusMode) return "off";
  if (e.agentCount < 1) return "off";
  if (e.reducedMotion) return "static";
  return e.anyActive ? "full" : "slow";
}

/** Minimum ms between redraws per mode. "static" still redraws occasionally so
 *  a layout change lands; it just never animates. */
export const TICK_MS: Record<TickMode, number> = { off: Infinity, static: 1000, slow: 250, full: 33 };
