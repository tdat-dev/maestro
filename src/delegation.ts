// Delegation visualization: when one agent hands work to another via the
// maestro-mcp `fleet_send` tool, draw a transient animated link on the canvas
// from the sender's pane to the target pane(s), AND pop a small bottom-right
// toast ("Ana → Bob: message") so the hand-off reads even when the panes
// involved are off-screen, scrolled away, or in a different workspace tab.
// Both are purely cosmetic — geometry/lookups are recomputed at draw time,
// every drawn element removes itself on a timer, and an unknown/absent
// sender is a silent no-op so delivery never depends on this module. One SVG
// overlay layer is created lazily per workspace grid and reused across
// calls; the toast is a single element lazily created on `document.body`.

import { type Pane, type Workspace } from "./panetypes";
import { workspaces } from "./appstate";

const SVG_NS = "http://www.w3.org/2000/svg";
const LIFETIME_MS = 2600;
const TOAST_LIFETIME_MS = 2600;
const TOAST_MESSAGE_MAX = 90;

const overlays = new WeakMap<Workspace, SVGSVGElement>();
let linkCounter = 0;
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
  animation:deleg-flow .5s linear infinite}
@keyframes deleg-flow{to{stroke-dashoffset:-14}}
@keyframes deleg-fade{0%{opacity:0}12%{opacity:1}75%{opacity:1}100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.deleg-path{animation:none}.deleg-dot{display:none}}
.deleg-toast{position:fixed;right:16px;bottom:70px;z-index:250;display:flex;align-items:center;gap:10px;
  max-width:360px;padding:10px 14px;border-radius:var(--r3);background:var(--surface-1);
  border:1px solid var(--line-2);box-shadow:0 24px 50px -18px rgba(0,0,0,.85);
  font-size:12.5px;color:var(--text);opacity:0;transform:translateY(8px);pointer-events:none;
  transition:opacity .28s,transform .28s}
.deleg-toast.on{opacity:1;transform:translateY(0)}
.deleg-toast-av{width:22px;height:22px;border-radius:var(--r1);flex:none;display:grid;place-items:center;
  font-size:11px;font-weight:800;color:var(--accent-ink);background:var(--muted-2)}
.deleg-toast-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.deleg-toast-arw{font-family:var(--mono);color:var(--accent)}
@media (prefers-reduced-motion:reduce){.deleg-toast{transition:none}}
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

/** A ~6×6 triangular `<marker>` filled with `color`, appended to `svg` under
 *  `id` so a path can reference it via `marker-end:url(#id)`. */
function addArrowMarker(svg: SVGSVGElement, id: string, color: string): void {
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", id);
  marker.setAttribute("viewBox", "0 0 6 6");
  marker.setAttribute("refX", "5");
  marker.setAttribute("refY", "3");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("orient", "auto-start-reverse");
  const tri = document.createElementNS(SVG_NS, "path");
  tri.setAttribute("d", "M0 0 L6 3 L0 6 Z");
  tri.setAttribute("fill", color);
  marker.appendChild(tri);
  svg.appendChild(marker);
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

/** Draw one transient flowing link from `from` to `to` into `svg`, stroked in
 *  `strokeColor` (the target pane's own colour) with an arrowhead, plus a
 *  travelling dot in `dotColor` (the sender's colour). Removed after its fade
 *  animation finishes. */
function drawLink(
  svg: SVGSVGElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  strokeColor: string,
  dotColor: string,
): void {
  linkCounter += 1;
  const id = `deleg-link-${linkCounter}`;
  const markerId = `${id}-arrow`;
  addArrowMarker(svg, markerId, strokeColor);

  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "deleg-link");

  // A cubic S-curve — flatter and more deliberate than a simple perpendicular
  // bow, and reads well between panes at any relative position.
  const midX = (from.x + to.x) / 2;
  const pathId = `deleg-path-${id}`;

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("id", pathId);
  path.setAttribute("class", "deleg-path");
  path.setAttribute("d", `M ${from.x} ${from.y} C ${midX} ${from.y} ${midX} ${to.y} ${to.x} ${to.y}`);
  path.setAttribute("stroke", strokeColor);
  path.setAttribute("marker-end", `url(#${markerId})`);
  g.appendChild(path);

  // A small dot riding the path from sender to target — optional flourish.
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", "deleg-dot");
  dot.setAttribute("r", "4");
  dot.setAttribute("fill", dotColor);
  const motion = document.createElementNS(SVG_NS, "animateMotion");
  motion.setAttribute("dur", "1s");
  motion.setAttribute("repeatCount", "2");
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
  // A zoomed-in focus pane's on-screen position is meaningless for drawing an
  // arc between panes — skip the visual, the toast still fires from bridges.
  if (ws.gridEl.classList.contains("has-focus")) return;
  const svg = overlayFor(ws);
  const from = center(sender);
  for (const target of toPanes) {
    if (target === sender) continue;
    drawLink(svg, from, center(target), target.color, sender.color);
  }
}

/* ---------------- delegation toast ---------------- */

let toastEl: HTMLElement | null = null;
let toastAvEl: HTMLElement | null = null;
let toastTextEl: HTMLElement | null = null;
let toastHideTimer: number | undefined;

/** The singleton toast element, created (or re-created, if a prior one was
 *  somehow removed from the DOM) on first use. Not scoped to a workspace —
 *  the toast is a viewport-level notification, unlike the canvas arc. */
function ensureToast(): { root: HTMLElement; av: HTMLElement; text: HTMLElement } {
  if (toastEl && toastAvEl && toastTextEl && document.body.contains(toastEl)) {
    return { root: toastEl, av: toastAvEl, text: toastTextEl };
  }
  ensureStyle();
  const root = document.createElement("div");
  root.className = "deleg-toast";
  const av = document.createElement("span");
  av.className = "deleg-toast-av";
  const text = document.createElement("span");
  text.className = "deleg-toast-text";
  root.append(av, text);
  document.body.appendChild(root);
  toastEl = root;
  toastAvEl = av;
  toastTextEl = text;
  return { root, av, text };
}

/** Find a pane's colour by agent name across every open workspace — the
 *  toast isn't scoped to one workspace's canvas, so it searches them all.
 *  Same case-insensitive/trimmed matching rule as `findPane`. */
function findPaneColor(name: string): string | undefined {
  const want = name.trim().toLowerCase();
  for (const ws of workspaces.values()) {
    for (const p of ws.panes.values()) {
      if (p.spec.name.trim().toLowerCase() === want) return p.color;
    }
  }
  return undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Trim a message to a toast-friendly length, on a word-ish boundary. */
function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Pop (or restart) the bottom-right delegation toast: "<sender> → <targets>:
 *  <message>". Reuses one element across calls, self-injecting into
 *  `document.body`. No-op (never throws) when `fromName` is null/blank or
 *  there are no targets — same rule as `showDelegation`; the caller's
 *  delivery must never depend on this succeeding. */
export function showDelegationToast(fromName: string | null, toNames: string[], message: string): void {
  if (!fromName || !fromName.trim() || toNames.length === 0) return;
  const { root, av, text } = ensureToast();
  const from = fromName.trim();
  const color = findPaneColor(from);
  av.textContent = from.slice(0, 1).toUpperCase() || "?";
  av.style.background = color ?? "var(--muted-2)";
  const toLabel = toNames.length <= 2 ? toNames.join(" & ") : `${toNames[0]} +${toNames.length - 1}`;
  text.innerHTML =
    `${escapeHtml(from)} <span class="deleg-toast-arw">&rarr;</span> ${escapeHtml(toLabel)}: ` +
    escapeHtml(truncate(message, TOAST_MESSAGE_MAX));
  root.classList.add("on");
  window.clearTimeout(toastHideTimer);
  toastHideTimer = window.setTimeout(() => root.classList.remove("on"), TOAST_LIFETIME_MS);
}
