// Terminal zoom keys: Ctrl+wheel over the terminals and Ctrl +/-/0. The zoom
// itself (clamping, persistence per project) lives in zoom.ts; applying it to
// the panes is pane.ts's applyZoom, injected here.

import { getZoom, stepZoom, zoomLabel } from "./zoom";
import { type Workspace } from "./panetypes";

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

function apply(next: number, note = false): void {
  const ws = getActiveWs();
  if (!ws) return;
  onZoom(ws, next);
  if (note) onNote(`Zoom ${zoomLabel(getZoom(ws))}`);
}

function nudge(dir: 1 | -1, note = false): void {
  const ws = getActiveWs();
  if (ws) apply(stepZoom(getZoom(ws), dir), note);
}

export function initZoomUi(): void {
  const main = document.querySelector(".main");
  if (!main) return;

  // Ctrl+wheel over the terminals. Non-passive so preventDefault sticks:
  // WebView2 would otherwise treat it as a browser page zoom and scale the
  // whole app, which is not what "make the terminals bigger" means.
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
}
