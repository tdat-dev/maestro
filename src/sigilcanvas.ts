// The fleet sigil's pixels: one <canvas> per workspace grid, sitting BELOW the
// panes (z-index 1) and above the wallpaper (z-index 0). It is only ever seen
// through see-through panes, which is the point — the tiling stays flush, no
// gutter is reserved for it, and the drawing reads across pane seams as one
// continuous instrument.
//
// Two constraints are load-bearing here:
//
//  1. CANVAS 2D ONLY. Never WebGL. terminal.ts keeps WEBGL_BUDGET at 0 because
//     on WebView2 a WebGL canvas stalls the compositor for 15-20s on unrelated
//     repaints and loses its context on idle. A decorative WebGL layer would
//     re-import that bug for no functional gain.
//
//  2. The loop STOPS. Not throttles — stops, with no timer pending, whenever
//     the window is hidden, the workspace isn't on screen, a pane has taken the
//     focus stage, or the sigil is switched off. Maestro sits parked for hours;
//     a background animation that idles at even 4fps is a real cost to pay for
//     something nobody is looking at.

import { activeWs } from "./appstate";
import { paneStatus } from "./fleet";
import { paneTone } from "./background";
import { type Workspace } from "./panetypes";
import {
  sigilGeometry,
  sigilBox,
  inkFor,
  breathe,
  coreAngle,
  pulseAt,
  sigilAlpha,
  tickMode,
  coreSidesFor,
  TICKS,
  TICK_MAJOR_EVERY,
  TICK_MS,
  type Pen,
  type SigilAgent,
  type SigilGeom,
  type TickMode,
} from "./sigil";

const TAU = Math.PI * 2;

/* ---------------- preference ---------------- */

interface SigilPref {
  on: boolean;
  /** 0…1 — scaled onto the alpha ceiling by sigil.ts, never used raw. */
  intensity: number;
}
const DEFAULT_PREF: SigilPref = { on: true, intensity: 0.8 };
// App-wide, like the wallpaper it is drawn on: everything in Settings →
// Appearance describes what Maestro looks like, not what a project contains.
// `maestro.sigil.<dir|id>` is what the per-workspace era wrote — read as a
// fallback so an existing choice survives, and cleared on the next write.
const KEY = "maestro.sigil";
const LEGACY_KEY = `${KEY}.`;

function parsePref(raw: string | null): SigilPref | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<SigilPref>;
    return {
      on: o.on !== false,
      intensity: typeof o.intensity === "number" ? Math.min(1, Math.max(0, o.intensity)) : DEFAULT_PREF.intensity,
    };
  } catch {
    return null;
  }
}

export function sigilPref(): SigilPref {
  const mine = parsePref(localStorage.getItem(KEY));
  if (mine) return mine;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(LEGACY_KEY)) {
      const old = parsePref(localStorage.getItem(k));
      if (old) return old;
    }
  }
  return DEFAULT_PREF;
}

function writePref(pref: SigilPref): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pref));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(LEGACY_KEY)) localStorage.removeItem(k);
    }
  } catch {
    /* quota — the setting just won't survive a restart */
  }
  refreshSigil();
}

/* ---------------- the canvas element ---------------- */

const CANVAS_CLASS = "sigil";

/** The workspace's sigil canvas, created on first use. Deliberately lazy: a
 *  workspace that never enters canvas mode never allocates one. */
function canvasFor(ws: Workspace): HTMLCanvasElement {
  let el = ws.gridEl.querySelector<HTMLCanvasElement>(`canvas.${CANVAS_CLASS}`);
  if (!el) {
    el = document.createElement("canvas");
    el.className = CANVAS_CLASS;
    el.setAttribute("aria-hidden", "true");
    // First child, so it lands behind the panes even before CSS is consulted.
    ws.gridEl.prepend(el);
    observer?.observe(ws.gridEl);
  }
  return el;
}

const dprNow = () => Math.min(3, window.devicePixelRatio || 1);

/**
 * Park the canvas over the sigil's own square and hand back a context whose
 * origin is the GRID's origin, not the canvas's.
 *
 * The offset lives in the transform so nothing downstream has to know the
 * canvas moved: geometry stays in grid coordinates, which is the coordinate
 * space the pane rects are already in.
 */
function sizeCanvas(
  el: HTMLCanvasElement,
  box: { x: number; y: number; size: number },
): CanvasRenderingContext2D | null {
  const dpr = dprNow();
  const px = Math.max(1, Math.round(box.size * dpr));
  if (el.width !== px || el.height !== px) {
    el.width = px;
    el.height = px;
  }
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
  el.style.width = `${box.size}px`;
  el.style.height = `${box.size}px`;
  const ctx = el.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, -box.x * dpr, -box.y * dpr);
  ctx.clearRect(box.x, box.y, box.size, box.size);
  return ctx;
}

let observer: ResizeObserver | null = null;

/* ---------------- pens ---------------- */
// The base pen flips with the wallpaper, the same decision paneTone already
// makes for the glyphs: light strokes over a dark photo, dark over a bright
// one. Status pens are the tokens the rest of the app already uses (--run,
// the attention amber), quoted as rgb triples so alpha can be applied per
// stroke without a colour-mix round trip on every frame.
const PENS: Record<"light" | "dark", Record<Pen, string>> = {
  light: { base: "255,255,255", run: "52,211,153", needs: "255,184,76", stopped: "148,163,184" },
  dark: { base: "12,16,22", run: "16,133,101", needs: "180,110,10", stopped: "71,85,105" },
};

function strokeOf(tone: "light" | "dark", pen: Pen, alpha: number): string {
  return `rgba(${PENS[tone][pen]},${alpha.toFixed(3)})`;
}

/* ---------------- drawing ---------------- */

function agentsOf(ws: Workspace, now: number): SigilAgent[] {
  const out: SigilAgent[] = [];
  for (const [id, p] of ws.panes) {
    const t = ws.layout.get(id);
    if (!t) continue;
    out.push({ id, rect: t, status: paneStatus(p, now) });
  }
  return out;
}

/* The still half of the drawing — the ruler, the arcs, the spokes and nodes —
   only changes when the layout, the statuses, the tone or the intensity change,
   which is to say almost never at 30fps. Re-stroking 60 ticks plus an arc, a
   spoke and a node per agent on every frame was the other half of what made
   smooth animation unaffordable; a blit of a cached bitmap is not. */
interface StaticLayer {
  key: string;
  canvas: HTMLCanvasElement;
}
const layers = new WeakMap<Workspace, StaticLayer>();

function layerKey(g: SigilGeom, box: { size: number }, tone: string, a0: number): string {
  return [
    box.size,
    dprNow(),
    tone,
    a0.toFixed(3),
    g.branches.map((b) => `${b.id}:${b.status}:${b.from.toFixed(3)}:${b.to.toFixed(3)}:${b.angle.toFixed(3)}`).join(","),
  ].join("|");
}

function staticLayer(
  ws: Workspace,
  g: SigilGeom,
  box: { x: number; y: number; size: number },
  tone: "light" | "dark",
  a0: number,
  ink: (p: Pen, w: number) => string,
): HTMLCanvasElement | null {
  const key = layerKey(g, box, tone, a0);
  const cached = layers.get(ws);
  if (cached && cached.key === key) return cached.canvas;

  const el = cached?.canvas ?? document.createElement("canvas");
  const ctx = sizeCanvas(el, box);
  if (!ctx) return null;
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  drawRuler(ctx, g, ink("base", 0.85));
  drawArcs(ctx, g, ink);
  drawSpokes(ctx, g, ink);
  layers.set(ws, { key, canvas: el });
  return el;
}

function drawSigil(ws: Workspace, t: number): void {
  const w = ws.gridEl.clientWidth;
  const h = ws.gridEl.clientHeight;
  if (w < 2 || h < 2) return;

  const agents = agentsOf(ws, Date.now());
  // No agents, no fleet to diagram. The spawn tile owns an empty canvas.
  if (!agents.length) return;

  const box = sigilBox({ width: w, height: h });
  const el = canvasFor(ws);
  const ctx = sizeCanvas(el, box);
  if (!ctx) return;

  const g = sigilGeometry({ width: w, height: h }, agents);
  const tone = paneTone();
  const a0 = sigilAlpha(sigilPref().intensity);
  const ink = (pen: Pen, weight: number) => strokeOf(tone, pen, a0 * weight);

  ctx.lineCap = "butt";
  ctx.lineJoin = "round";

  const still = staticLayer(ws, g, box, tone, a0, ink);
  if (still) ctx.drawImage(still, box.x, box.y, box.size, box.size);

  drawPulses(ctx, g, t, ink);
  drawInnerRing(ctx, g, t, ink("base", 0.7));
  drawCore(ctx, g, t, ink("base", 1));
}

/** Outer ring: a measuring rim, and the only part of the sigil that never
 *  moves. Everything else reads as live because this doesn't. */
function drawRuler(ctx: CanvasRenderingContext2D, g: SigilGeom, stroke: string): void {
  ctx.strokeStyle = stroke;
  // 1.4 rather than 1: over a photograph a true hairline is lost in the grain
  // whatever its alpha, and raising alpha instead only makes a faint smudge.
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.rOuter, 0, TAU);
  ctx.stroke();

  const minor = Math.max(4, g.rOuter * 0.018);
  const major = minor * 2.6;
  ctx.beginPath();
  for (let i = 0; i < TICKS; i++) {
    const a = (i / TICKS) * TAU;
    const len = i % TICK_MAJOR_EVERY === 0 ? major : minor;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    ctx.moveTo(g.cx + cos * g.rOuter, g.cy + sin * g.rOuter);
    ctx.lineTo(g.cx + cos * (g.rOuter + len), g.cy + sin * (g.rOuter + len));
  }
  ctx.stroke();
}

/** Middle ring: one arc per agent, covering exactly the angle its pane
 *  occupies. Two panes side by side give two half-rings; a 2×2 tidy gives four
 *  quadrants. The ring IS the layout. */
function drawArcs(ctx: CanvasRenderingContext2D, g: SigilGeom, ink: (p: Pen, w: number) => string): void {
  for (const b of g.branches) {
    if (b.to <= b.from) continue;
    const k = inkFor(b.status);
    ctx.strokeStyle = ink(k.pen, k.weight);
    ctx.lineWidth = k.pen === "base" || k.pen === "stopped" ? 1.4 : 2.2;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.rMid, b.from, b.to);
    ctx.stroke();
  }
}

/** Where an agent's spoke starts and ends — shared by the still spoke and the
 *  pulse that travels along it, so the two can never drift apart. */
function spokeEnds(g: SigilGeom, angle: number) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x0: g.cx + cos * g.rCore,
    y0: g.cy + sin * g.rCore,
    x1: g.cx + cos * g.rMid,
    y1: g.cy + sin * g.rMid,
  };
}

/** Spokes and nodes: one per live agent, pointing at its pane's centre. Only
 *  agents that exist get a spoke — no pre-drawn compass arms. Still: this goes
 *  in the cached layer. */
function drawSpokes(ctx: CanvasRenderingContext2D, g: SigilGeom, ink: (p: Pen, w: number) => string): void {
  const nodeR = Math.max(3, g.rMid * 0.022);
  for (const b of g.branches) {
    const k = inkFor(b.status);
    const { x0, y0, x1, y1 } = spokeEnds(g, b.angle);

    ctx.strokeStyle = ink(k.pen, k.weight * 0.6);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    ctx.strokeStyle = ink(k.pen, k.weight);
    ctx.fillStyle = ink(k.pen, k.weight);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x1, y1, nodeR, 0, TAU);
    if (k.filled) ctx.fill();
    else ctx.stroke();
  }
}

/** The pulse: a short bright segment running core → node. The only travelling
 *  motion in the sigil, and only a working agent gets one — so on a fleet
 *  where nobody is producing output this draws nothing at all. */
function drawPulses(ctx: CanvasRenderingContext2D, g: SigilGeom, t: number, ink: (p: Pen, w: number) => string): void {
  g.branches.forEach((b, i) => {
    const k = inkFor(b.status);
    if (!k.pulse) return;
    const { x0, y0, x1, y1 } = spokeEnds(g, b.angle);
    const p = pulseAt(t, i);
    const tail = Math.max(0, p - 0.12);
    ctx.strokeStyle = ink(k.pen, Math.min(1.6, k.weight * 1.6));
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(x0 + (x1 - x0) * tail, y0 + (y1 - y0) * tail);
    ctx.lineTo(x0 + (x1 - x0) * p, y0 + (y1 - y0) * p);
    ctx.stroke();
  });
}

/** Inner ring: the fleet's pulse, breathing ±2%. Slow enough to be felt rather
 *  than watched. */
function drawInnerRing(ctx: CanvasRenderingContext2D, g: SigilGeom, t: number, stroke: string): void {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.rInner * breathe(t), 0, TAU);
  ctx.stroke();
}

/** Core: a polygon with one side per agent — two agents is a bare line, four a
 *  square, six a hexagon. Turns once every two minutes, so it is never the
 *  thing your eye catches, only the thing you notice has changed. */
function drawCore(ctx: CanvasRenderingContext2D, g: SigilGeom, t: number, stroke: string): void {
  const sides = coreSidesFor(g.branches.length);
  if (sides < 1) return;
  ctx.strokeStyle = stroke;
  ctx.fillStyle = stroke;
  ctx.lineWidth = 1.8;
  const rot = coreAngle(t) - Math.PI / 2;

  if (sides === 1) {
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, Math.max(2, g.rCore * 0.35), 0, TAU);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * TAU;
    const x = g.cx + Math.cos(a) * g.rCore;
    const y = g.cy + Math.sin(a) * g.rCore;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  // Two "sides" is a diameter, not a polygon — leave it open so it draws as the
  // single line it is instead of a doubled-back zero-area shape.
  if (sides > 2) ctx.closePath();
  ctx.stroke();
}

/* ---------------- the loop ---------------- */

// One scheduler per mode, and only two modes that draw. "live" rides
// requestAnimationFrame (vsync-aligned, gated to ~30fps) because everything
// that moves must move smoothly or not at all. "still" rides a 1s timer purely
// so a status change lands, and is handed a frozen clock, so those redraws are
// pixel-identical and cannot be seen. Both are cancelled outright in "off".
let raf = 0;
let timer = 0;
let lastDraw = -Infinity;
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function modeFor(ws: Workspace | null): { ws: Workspace | null; mode: TickMode } {
  if (!ws) return { ws: null, mode: "off" };
  const now = Date.now();
  let anyAlive = false;
  for (const p of ws.panes.values()) {
    if (paneStatus(p, now) !== "stopped") {
      anyAlive = true;
      break;
    }
  }
  const mode = tickMode({
    enabled: sigilPref().on,
    visible: document.visibilityState !== "hidden",
    wsActive: !ws.gridEl.hidden,
    canvasMode: ws.gridEl.classList.contains("canvas"),
    focusMode: ws.gridEl.classList.contains("has-focus"),
    reducedMotion: reduced(),
    agentCount: ws.panes.size,
    anyAlive,
  });
  return { ws, mode };
}

function stopLoop(): void {
  if (raf) cancelAnimationFrame(raf);
  if (timer) clearTimeout(timer);
  raf = 0;
  timer = 0;
}

function step(t: number): void {
  raf = 0;
  timer = 0;
  const { ws, mode } = modeFor(activeWs);
  if (!ws || mode === "off") return; // nothing re-queued: the loop is stopped
  if (t - lastDraw >= TICK_MS[mode]) {
    lastDraw = t;
    // "still" is handed a frozen clock on purpose. Its redraws exist to pick up
    // a status change, not to animate; passing the real clock would sample the
    // breathing and the core's turn once a second, which is exactly the
    // stuttering-at-2fps look this mode was created to avoid.
    drawSigil(ws, mode === "live" ? t : 0);
  }
  if (mode === "live") raf = requestAnimationFrame(step);
  else timer = window.setTimeout(() => step(performance.now()), TICK_MS[mode]);
}

/**
 * Re-evaluate whether the sigil should be running, and start/stop accordingly.
 * Cheap and idempotent — call it from anything that changes the picture: a
 * layout change, a spawn or kill, a workspace switch, focus in or out, a
 * preference change.
 */
export function refreshSigil(): void {
  // Clear a stale drawing the moment the sigil is switched off or covered,
  // rather than leaving the last frame frozen under the panes.
  const { ws, mode } = modeFor(activeWs);
  if (!ws || mode === "off") {
    stopLoop();
    if (ws) {
      const el = ws.gridEl.querySelector<HTMLCanvasElement>(`canvas.${CANVAS_CLASS}`);
      el?.getContext("2d")?.clearRect(0, 0, el.width, el.height);
    }
    return;
  }
  lastDraw = -Infinity; // the next step draws immediately, whatever the mode
  if (!raf && !timer) step(performance.now());
}

/** Wire the sigil up: the resize observer, the visibility gate, and the
 *  Settings → Appearance controls. Call once at startup. */
export function initSigil(): void {
  observer = new ResizeObserver(() => refreshSigil());
  document.addEventListener("visibilitychange", () => refreshSigil());

  const toggle = document.getElementById("sigilOn") as HTMLInputElement | null;
  toggle?.addEventListener("change", () => {
    writePref({ ...sigilPref(), on: toggle.checked });
  });

  const range = document.getElementById("sigilIntensity") as HTMLInputElement | null;
  range?.addEventListener("input", () => {
    writePref({ ...sigilPref(), intensity: Number(range.value) / 100 });
    markSigil();
  });

  // Same hooks background.ts uses to refresh its own controls when Settings opens.
  document.getElementById("btnSettingsHome")?.addEventListener("click", markSigil);
  document.getElementById("cbSettings")?.addEventListener("click", markSigil);
  markSigil();
  refreshSigil();
}

/** Reflect the saved sigil preference in the Appearance controls. */
export function markSigil(): void {
  const pref = sigilPref();
  const toggle = document.getElementById("sigilOn") as HTMLInputElement | null;
  if (toggle) toggle.checked = pref.on;
  const range = document.getElementById("sigilIntensity") as HTMLInputElement | null;
  if (range) range.value = String(Math.round(pref.intensity * 100));
  const out = document.getElementById("sigilIntensityVal");
  if (out) out.textContent = `${Math.round(pref.intensity * 100)}%`;
}
