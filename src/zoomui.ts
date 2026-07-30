// The canvas zoom control: a pill beside Tidy, Ctrl+wheel, and Ctrl +/-/0.
// Self-injected (style + markup) like topbarchrome.ts, so it lands without
// touching index.html. The zoom itself — clamping, persistence, precedence over
// auto-fit — lives in zoom.ts; this is only its surface.

import { getZoom, stepZoom, zoomLabel, ZOOM_MIN, ZOOM_MAX } from "./zoom";
import { type Workspace } from "./panetypes";

const STYLE_ID = "canvas-zoom-style";
const PILL_ID = "canvasZoom";

let getActiveWs: () => Workspace | null = () => null;
let onZoom: (ws: Workspace, next: number) => void = () => {};
let onNote: (text: string) => void = () => {};
export function configureZoomUi(deps: {
  getActiveWs: () => Workspace | null;
  /** Apply and persist — pane.ts's applyZoom. */
  applyZoom: (ws: Workspace, next: number) => void;
  note: (text: string) => void;
}): void {
  getActiveWs = deps.getActiveWs;
  onZoom = deps.applyZoom;
  onNote = deps.note;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  // Sits to the left of .tidy-fab (right:16px) and borrows its glass pill look.
  s.textContent = `
#${PILL_ID}{position:absolute;right:104px;top:14px;z-index:5;display:none;align-items:center;gap:2px;
  padding:3px 4px;border-radius:9px;background:rgba(16,20,26,.85);backdrop-filter:blur(10px);
  border:1px solid var(--line-2)}
#${PILL_ID}.on{display:inline-flex}
#${PILL_ID} button{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;
  color:var(--muted);font-size:14px;line-height:1;background:none;border:0;transition:color .15s,background .15s}
#${PILL_ID} button:hover:not(:disabled){color:var(--text);background:rgba(255,255,255,.08)}
#${PILL_ID} button:disabled{opacity:.35}
#${PILL_ID} .z-n{min-width:44px;text-align:center;font-family:var(--mono);font-size:11.5px;
  color:var(--muted);cursor:pointer;user-select:none}
#${PILL_ID} .z-n:hover{color:var(--text)}`;
  document.head.appendChild(s);
}

function pill(): HTMLElement | null {
  return document.getElementById(PILL_ID);
}

/** Reflect the active workspace's zoom, and hide the control on Home (where
 *  there is no canvas to zoom). */
export function syncZoomUi(): void {
  const host = pill();
  if (!host) return;
  const ws = getActiveWs();
  host.classList.toggle("on", !!ws);
  if (!ws) return;
  const z = getZoom(ws);
  const n = host.querySelector<HTMLElement>(".z-n");
  if (n) n.textContent = zoomLabel(z);
  host.querySelector<HTMLButtonElement>("[data-z='out']")?.toggleAttribute("disabled", z <= ZOOM_MIN);
  host.querySelector<HTMLButtonElement>("[data-z='in']")?.toggleAttribute("disabled", z >= ZOOM_MAX);
}

function apply(next: number, note = false): void {
  const ws = getActiveWs();
  if (!ws) return;
  onZoom(ws, next);
  syncZoomUi();
  if (note) onNote(`Zoom ${zoomLabel(getZoom(ws))}`);
}

function nudge(dir: 1 | -1, note = false): void {
  const ws = getActiveWs();
  if (ws) apply(stepZoom(getZoom(ws), dir), note);
}

export function initZoomUi(): void {
  injectStyle();
  const main = document.querySelector(".main");
  if (!main || document.getElementById(PILL_ID)) return;

  const host = document.createElement("div");
  host.id = PILL_ID;
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", "Canvas zoom");
  host.innerHTML =
    '<button type="button" data-z="out" aria-label="Zoom out" title="Zoom out — Ctrl+−">−</button>' +
    '<span class="z-n" data-z="reset" role="button" tabindex="0" title="Reset to 100% — Ctrl+0">100%</span>' +
    '<button type="button" data-z="in" aria-label="Zoom in" title="Zoom in — Ctrl++">+</button>';
  main.appendChild(host);

  host.querySelector("[data-z='out']")?.addEventListener("click", () => nudge(-1));
  host.querySelector("[data-z='in']")?.addEventListener("click", () => nudge(1));
  const reset = host.querySelector<HTMLElement>("[data-z='reset']");
  reset?.addEventListener("click", () => apply(1));
  reset?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      apply(1);
    }
  });

  // Ctrl+wheel over the canvas. Non-passive so preventDefault sticks: WebView2
  // would otherwise treat it as a browser page zoom and scale the whole app
  // chrome, which is not what "make the terminals bigger" means.
  main.addEventListener(
    "wheel",
    (e) => {
      const ev = e as WheelEvent;
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      if (ev.deltaY !== 0) nudge(ev.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  // Ctrl +/-/0. xterm sees the keydown first, but it does not claim these, so
  // they arrive here. `code` rather than `key`: on the numpad and on layouts
  // where + needs Shift, `key` is unreliable.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.code === "Equal" || e.code === "NumpadAdd") {
      e.preventDefault();
      nudge(1, true);
    } else if (e.code === "Minus" || e.code === "NumpadSubtract") {
      e.preventDefault();
      nudge(-1, true);
    } else if (e.code === "Digit0" || e.code === "Numpad0") {
      e.preventDefault();
      apply(1, true);
    }
  });

  syncZoomUi();
}
