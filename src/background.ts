// Per-workspace canvas background — a faithful port of the approved mockup's
// Settings → Appearance background picker. Each workspace's `.grid.canvas` can
// carry one of five presets, a solid colour, or an uploaded image (downscaled
// to a data-URI so it fits in localStorage). The choice is keyed per workspace
// (same key space as the canvas layout) and re-applied on every activate. The
// picker markup lives in index.html; this module owns the presets + wiring.

import { type Workspace } from "./panetypes";

// Applied-to-canvas backgrounds (subtler than the boosted swatch previews in the
// markup). `grid` toggles the 34px `.sg-grid` overlay defined in canvas.css.
interface BgPreset { bg: string; grid: boolean }
const PRESETS: Record<string, BgPreset> = {
  glow: {
    bg:
      "radial-gradient(1100px 700px at 88% -8%,rgba(198,241,53,.15),transparent 62%)," +
      "radial-gradient(900px 650px at -8% 108%,rgba(56,189,248,.12),transparent 60%),var(--bg)",
    grid: true,
  },
  dark: { bg: "var(--bg)", grid: false },
  grid: { bg: "var(--bg)", grid: true },
  violet: {
    bg:
      "radial-gradient(1000px 700px at 85% -10%,rgba(139,92,246,.18),transparent 60%)," +
      "radial-gradient(800px 600px at 0% 110%,rgba(236,72,153,.10),transparent 60%),#0a0910",
    grid: false,
  },
  ocean: {
    bg:
      "radial-gradient(1000px 700px at 80% -10%,rgba(56,189,248,.18),transparent 60%)," +
      "radial-gradient(800px 600px at 0% 110%,rgba(45,212,191,.12),transparent 60%),#070d12",
    grid: false,
  },
};
const DEFAULT_KIND = "glow"; // mockup opens with "glow" marked active

// A larger uploaded photo is downscaled to this longest edge before it becomes a
// data-URI — keeps localStorage under quota and the paint cheap.
const IMG_MAX_EDGE = 1920;

type BgKind = "preset" | "color" | "image";
interface BgSpec { kind: BgKind; value: string }

const key = (ws: Workspace) => `maestro.canvasBg.${ws.dir ?? ws.id}`;

let getActiveWs: () => Workspace | null = () => null;
let onToast: (text: string) => void = () => {};
export function configureBackground(deps: {
  getActiveWs: () => Workspace | null;
  toast: (text: string) => void;
}): void {
  getActiveWs = deps.getActiveWs;
  onToast = deps.toast;
}

function readSpec(ws: Workspace): BgSpec | null {
  const raw = localStorage.getItem(key(ws));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<BgSpec>;
    if ((o.kind === "preset" || o.kind === "color" || o.kind === "image") && typeof o.value === "string")
      return { kind: o.kind, value: o.value };
  } catch {
    /* malformed — treat as default */
  }
  return null;
}

/** Paint `ws`'s canvas from its saved background (default = the "glow" preset).
 *  Called on every activate, so switching tabs always shows the right one. */
export function applyBackground(ws: Workspace): void {
  const spec = readSpec(ws);
  if (!spec || spec.kind === "preset") {
    const p = PRESETS[spec?.value ?? DEFAULT_KIND] ?? PRESETS[DEFAULT_KIND];
    ws.gridEl.style.background = p.bg;
    ws.gridEl.classList.toggle("sg-grid", p.grid);
    return;
  }
  ws.gridEl.classList.remove("sg-grid");
  if (spec.kind === "color") {
    ws.gridEl.style.background = spec.value;
  } else {
    // Uploaded image: a dark scrim over cover art keeps the panes legible.
    ws.gridEl.style.background =
      `linear-gradient(rgba(9,10,12,.55),rgba(9,10,12,.62)),url("${spec.value}") center / cover no-repeat`;
  }
}

function setSpec(ws: Workspace, spec: BgSpec): void {
  try {
    localStorage.setItem(key(ws), JSON.stringify(spec));
  } catch {
    onToast("Couldn't save the background — the image may be too large.");
    return;
  }
  applyBackground(ws);
  markActive(ws);
  onToast(spec.kind === "image" ? "Background image set" : "Background updated");
}

/** Downscale an image File to a JPEG data-URI no larger than IMG_MAX_EDGE. */
function fileToScaledDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, IMG_MAX_EDGE / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no 2d context"));
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

/* ---------------- picker UI (Settings → Appearance) ---------------- */

const bgGrid = () => document.getElementById("bgGrid");

/** Highlight the preset swatch matching the active workspace's choice (none for
 *  a custom colour/image, exactly like the mockup's markBg("")). */
function markActive(ws: Workspace | null): void {
  const host = bgGrid();
  if (!host) return;
  const spec = ws ? readSpec(ws) : null;
  const activeId = !spec ? DEFAULT_KIND : spec.kind === "preset" ? spec.value : "";
  host.querySelectorAll<HTMLElement>(".bg-opt[data-bg]").forEach((o) => {
    o.classList.toggle("on", o.dataset.bg === activeId);
  });
  const color = document.getElementById("bgColor") as HTMLInputElement | null;
  if (color && spec?.kind === "color") color.value = spec.value;
}

/** Wire the preset swatches, the custom colour, the image upload, and refresh
 *  the picker whenever Settings opens. Call once at startup. */
export function initBackground(): void {
  bgGrid()?.querySelectorAll<HTMLElement>(".bg-opt[data-bg]").forEach((opt) => {
    opt.addEventListener("click", () => {
      const ws = getActiveWs();
      if (ws && opt.dataset.bg) setSpec(ws, { kind: "preset", value: opt.dataset.bg });
    });
  });

  document.getElementById("bgColor")?.addEventListener("input", (e) => {
    const ws = getActiveWs();
    if (ws) setSpec(ws, { kind: "color", value: (e.target as HTMLInputElement).value });
  });

  const bgImg = document.getElementById("bgImg") as HTMLInputElement | null;
  bgImg?.addEventListener("change", async () => {
    const file = bgImg.files?.[0];
    bgImg.value = ""; // let the same file be re-picked later
    const ws = getActiveWs();
    if (!file || !ws) return;
    try {
      setSpec(ws, { kind: "image", value: await fileToScaledDataUri(file) });
    } catch {
      onToast("Couldn't load that image.");
    }
  });

  // Reflect the active workspace's choice whenever Settings opens.
  document.getElementById("btnSettings")?.addEventListener("click", () => markActive(getActiveWs()));
  document.getElementById("btnSettingsHome")?.addEventListener("click", () => markActive(getActiveWs()));
  document.getElementById("cbSettings")?.addEventListener("click", () => markActive(getActiveWs()));
}
