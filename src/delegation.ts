// Delegation visualization: when one agent hands work to another via the
// maestro-mcp `fleet_send` tool, draw a transient animated link on the canvas
// from the sender's pane to the target pane(s). Purely cosmetic — geometry is
// recomputed at draw time (panes move/resize/focus), every drawn element
// removes itself on a timer, and an unknown/absent sender is a silent no-op
// so delivery never depends on this module. One SVG overlay layer is created
// lazily per workspace grid and reused across calls.

import { type Pane, type Workspace } from "./panetypes";

const SVG_NS = "http://www.w3.org/2000/svg";
const LIFETIME_MS = 1500;

const overlays = new WeakMap<Workspace, SVGSVGElement>();
let gradCounter = 0;
let styleInjected = false;

/** Inject the overlay's CSS once, the first time anything is ever drawn. */
function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.deleg-overlay{position:absolute;inset:0;z-index:20;overflow:visible;pointer-events:none}
.deleg-link{opacity:0;animation:deleg-fade ${LIFETIME_MS}ms ease-out forwards}
.deleg-path{fill:none;stroke-width:2;stroke-linecap:round;stroke-dasharray:7 7;
  animation:deleg-flow .7s linear infinite}
.deleg-dot{filter:drop-shadow(0 0 4px var(--accent))}
@keyframes deleg-flow{to{stroke-dashoffset:-28}}
@keyframes deleg-fade{0%{opacity:0}12%{opacity:1}75%{opacity:1}100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.deleg-path{animation:none}.deleg-dot{display:none}}
`;
  document.head.appendChild(style);
}

/** The overlay SVG for a workspace's canvas, creating (and re-attaching, if a
 *  prior one was somehow detached) it on first use. */
function overlayFor(ws: Workspace): SVGSVGElement {
  const existing = overlays.get(ws);
  if (existing && ws.gridEl.contains(existing)) return existing;
  ensureStyle();
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("class", "deleg-overlay");
  ws.gridEl.appendChild(svg);
  overlays.set(ws, svg);
  return svg;
}

/** A fresh brand-gradient `<linearGradient>` inside `svg`, returning its id. */
function addGradient(svg: SVGSVGElement): string {
  gradCounter += 1;
  const id = `deleg-grad-${gradCounter}`;
  const grad = document.createElementNS(SVG_NS, "linearGradient");
  grad.setAttribute("id", id);
  grad.setAttribute("gradientUnits", "userSpaceOnUse");
  const stop1 = document.createElementNS(SVG_NS, "stop");
  stop1.setAttribute("offset", "0%");
  stop1.setAttribute("stop-color", "#c6f135");
  const stop2 = document.createElementNS(SVG_NS, "stop");
  stop2.setAttribute("offset", "100%");
  stop2.setAttribute("stop-color", "#27b9a3");
  grad.append(stop1, stop2);
  svg.appendChild(grad);
  return id;
}

/** Find a pane by agent name, case-insensitive and trimmed (same matching
 *  rule as the MCP-side `agent_output` lookup). */
function findPane(ws: Workspace, name: string): Pane | undefined {
  const want = name.trim().toLowerCase();
  for (const p of ws.panes.values()) if (p.spec.name.trim().toLowerCase() === want) return p;
  return undefined;
}

/** A pane's center, in coordinates relative to `ws.gridEl` — panes are
 *  absolutely positioned direct children of it, so offsetLeft/Top already are
 *  that coordinate space (no getBoundingClientRect/scroll math needed). */
function center(pane: Pane): { x: number; y: number } {
  return {
    x: pane.el.offsetLeft + pane.el.offsetWidth / 2,
    y: pane.el.offsetTop + pane.el.offsetHeight / 2,
  };
}

/** Draw one transient flowing link from `from` to `to` into `svg`, and remove
 *  it after its animation finishes. */
function drawLink(svg: SVGSVGElement, from: { x: number; y: number }, to: { x: number; y: number }): void {
  const gradId = addGradient(svg);
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "deleg-link");

  // A gentle bow perpendicular to the line, so hand-offs between the same two
  // panes (or ones that happen to line up) don't stack exactly on top of
  // each other and read as a single blob.
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(48, len * 0.18);
  const cx = (from.x + to.x) / 2 - (dy / len) * bow;
  const cy = (from.y + to.y) / 2 + (dx / len) * bow;
  const pathId = `deleg-path-${gradId}`;

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("id", pathId);
  path.setAttribute("class", "deleg-path");
  path.setAttribute("d", `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`);
  path.setAttribute("stroke", `url(#${gradId})`);
  g.appendChild(path);

  // A small dot riding the path from sender to target — optional flourish,
  // freezes at the target so it reads as "arrived" for the rest of the fade.
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", "deleg-dot");
  dot.setAttribute("r", "3.5");
  dot.setAttribute("fill", "#eafccb");
  const motion = document.createElementNS(SVG_NS, "animateMotion");
  motion.setAttribute("dur", "0.8s");
  motion.setAttribute("fill", "freeze");
  const mpath = document.createElementNS(SVG_NS, "mpath");
  mpath.setAttribute("href", `#${pathId}`);
  motion.appendChild(mpath);
  dot.appendChild(motion);
  g.appendChild(dot);

  svg.appendChild(g);
  window.setTimeout(() => g.remove(), LIFETIME_MS);
}

/** Draw a transient delegation link from `fromName`'s pane to each of
 *  `toPanes`, on `ws`'s canvas. No-op (never throws) when `fromName` is
 *  null/blank or doesn't match a pane in this workspace — delivery must keep
 *  working exactly the same whether or not we can visualize it. */
export function showDelegation(ws: Workspace, fromName: string | null, toPanes: Pane[]): void {
  if (!fromName || !fromName.trim() || toPanes.length === 0) return;
  const sender = findPane(ws, fromName);
  if (!sender) return;
  const svg = overlayFor(ws);
  const from = center(sender);
  for (const target of toPanes) {
    if (target === sender) continue;
    drawLink(svg, from, center(target));
  }
}
