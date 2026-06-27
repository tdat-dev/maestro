// Resize splitters for the project rail (left) and code panel (right), plus
// persistence of their widths. Uses pointer events (setPointerCapture) — NOT
// HTML5 drag — so dragging never interacts with the OS file-drop machinery.

interface SplitCfg {
  key: string;
  varName: string;
  min: number;
  max: number;
  def: number;
}

const RAIL: SplitCfg = { key: "maestro.railW", varName: "--rail-w", min: 150, max: 480, def: 216 };
const CODE: SplitCfg = { key: "maestro.codeW", varName: "--code-w", min: 240, max: 760, def: 380 };

/** Clamp a pixel width into [min, max]. */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, px));
}

function restore(app: HTMLElement, cfg: SplitCfg): void {
  const saved = Number(localStorage.getItem(cfg.key));
  const w = clampWidth(Number.isFinite(saved) && saved > 0 ? saved : cfg.def, cfg.min, cfg.max);
  app.style.setProperty(cfg.varName, `${w}px`);
}

function wireSplitter(
  app: HTMLElement,
  handle: HTMLElement,
  cfg: SplitCfg,
  edge: "left" | "right",
): void {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("splitting");
    const rect = app.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      // Left rail grows with cursor X; right panel grows as cursor moves left.
      const raw = edge === "left" ? ev.clientX - rect.left : rect.right - ev.clientX;
      app.style.setProperty(cfg.varName, `${clampWidth(raw, cfg.min, cfg.max)}px`);
    };
    const up = () => {
      handle.releasePointerCapture(e.pointerId);
      document.body.classList.remove("splitting");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      const cur = app.style.getPropertyValue(cfg.varName).replace("px", "").trim();
      localStorage.setItem(cfg.key, cur);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

/** Restore persisted widths and make both splitters draggable. */
export function initPanels(): void {
  const app = document.getElementById("app");
  const railSplit = document.getElementById("railSplit");
  const codeSplit = document.getElementById("codeSplit");
  if (!app || !railSplit || !codeSplit) return;
  restore(app, RAIL);
  restore(app, CODE);
  wireSplitter(app, railSplit, RAIL, "left");
  wireSplitter(app, codeSplit, CODE, "right");
}
