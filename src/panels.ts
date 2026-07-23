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

/** Wire a show/hide toggle for one side panel: persists the collapsed state,
 *  reflects it on the `.app` class + the button's `.on` (visible) state. */
function wireToggle(app: HTMLElement, btn: HTMLElement, cls: string, key: string): void {
  const apply = (hidden: boolean) => {
    app.classList.toggle(cls, hidden);
    btn.classList.toggle("on", !hidden); // lit when the panel is visible
  };
  apply(localStorage.getItem(key) === "1");
  btn.addEventListener("click", () => {
    const hidden = !app.classList.contains(cls);
    localStorage.setItem(key, hidden ? "1" : "0");
    apply(hidden);
  });
}

/** Restore persisted widths, make both splitters draggable, wire show/hide. */
export function initPanels(): void {
  const app = document.getElementById("app");
  const codeSplit = document.getElementById("codeSplit");
  if (!app || !codeSplit) return;
  restore(app, CODE);
  wireSplitter(app, codeSplit, CODE, "right");

  const codeBtn = document.getElementById("btnToggleCode");
  if (codeBtn) wireToggle(app, codeBtn, "code-hidden", "maestro.codeHidden");
  // The code panel's own "›‹" header button mirrors the topbar toggle.
  document.getElementById("cpClose")?.addEventListener("click", () => codeBtn?.click());

  // Keyboard: Ctrl+Shift+B → sidebar, Ctrl+Shift+E → code panel (matches the
  // dock's Ctrl+Shift+* convention; avoids clashing with xterm key handling).
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "e") {
      e.preventDefault();
      codeBtn?.click();
    }
  });
}
