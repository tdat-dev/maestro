// Per-workspace canvas background — a faithful port of the approved mockup's
// Settings → Appearance background picker. Each workspace's `.grid.canvas` can
// carry one of five presets, a solid colour, or an uploaded image (downscaled
// to a data-URI so it fits in localStorage). The choice is keyed per workspace
// (same key space as the canvas layout) and re-applied on every activate. The
// picker markup lives in index.html; this module owns the presets + wiring.

import { type Workspace } from "./panetypes";
import {
  hexToRgb,
  relLuminance,
  composite,
  meanRgb,
  resolveTone,
  paletteFor,
  type Rgb,
  type ToneMode,
} from "./termtheme";
import { type PaneLook } from "./terminal";

// Applied-to-canvas backgrounds (subtler than the boosted swatch previews in the
// markup). `grid` toggles the 34px `.sg-grid` overlay defined in canvas.css.
// `base` is the flat colour a see-through pane ends up sitting on — the radial
// tints are too faint to move the tone decision, so the base is enough.
interface BgPreset { bg: string; grid: boolean; base: Rgb }
const PRESETS: Record<string, BgPreset> = {
  glow: {
    bg:
      "radial-gradient(1100px 700px at 88% -8%,rgba(198,241,53,.15),transparent 62%)," +
      "radial-gradient(900px 650px at -8% 108%,rgba(56,189,248,.12),transparent 60%),var(--bg)",
    grid: true,
    base: [9, 10, 12],
  },
  dark: { bg: "var(--bg)", grid: false, base: [9, 10, 12] },
  grid: { bg: "var(--bg)", grid: true, base: [9, 10, 12] },
  violet: {
    bg:
      "radial-gradient(1000px 700px at 85% -10%,rgba(139,92,246,.18),transparent 60%)," +
      "radial-gradient(800px 600px at 0% 110%,rgba(236,72,153,.10),transparent 60%),#0a0910",
    grid: false,
    base: [10, 9, 16],
  },
  ocean: {
    bg:
      "radial-gradient(1000px 700px at 80% -10%,rgba(56,189,248,.18),transparent 60%)," +
      "radial-gradient(800px 600px at 0% 110%,rgba(45,212,191,.12),transparent 60%),#070d12",
    grid: false,
    base: [7, 13, 18],
  },
};

/** The scrim applied over an uploaded photo (see applyBackground) — the tone
 *  decision has to account for it, or a bright photo reads as light when what
 *  the pane actually sits on is the darkened version. */
const IMG_SCRIM: Rgb = [9, 10, 12];
const IMG_SCRIM_ALPHA = 0.585; // the .55 → .62 gradient, averaged
const DEFAULT_KIND = "glow"; // mockup opens with "glow" marked active

// A larger uploaded photo is downscaled to this longest edge before it becomes a
// data-URI — keeps localStorage under quota and the paint cheap.
const IMG_MAX_EDGE = 1920;

type BgKind = "preset" | "color" | "image";
/** `avg` is the uploaded image's mean colour, measured at upload time — the
 *  cheap way to know how bright a wallpaper is without re-decoding it on every
 *  activate. Absent on specs saved before see-through panes existed. */
interface BgSpec { kind: BgKind; value: string; avg?: Rgb }

/** Per-workspace pane appearance, saved alongside the background. */
interface LookPref { tone: ToneMode; opacity: number }
const DEFAULT_LOOK: LookPref = { tone: "auto", opacity: 0 };

const key = (ws: Workspace) => `maestro.canvasBg.${ws.dir ?? ws.id}`;
const lookKey = (ws: Workspace) => `maestro.paneLook.${ws.dir ?? ws.id}`;

let getActiveWs: () => Workspace | null = () => null;
let onToast: (text: string) => void = () => {};
let onLookChange: (ws: Workspace) => void = () => {};
export function configureBackground(deps: {
  getActiveWs: () => Workspace | null;
  toast: (text: string) => void;
  /** Re-theme `ws`'s live panes — the background and the glyph tone are one
   *  decision now, so every background change has to reach the terminals. */
  onLookChange?: (ws: Workspace) => void;
}): void {
  getActiveWs = deps.getActiveWs;
  onToast = deps.toast;
  if (deps.onLookChange) onLookChange = deps.onLookChange;
}

function readSpec(ws: Workspace): BgSpec | null {
  const raw = localStorage.getItem(key(ws));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<BgSpec>;
    if ((o.kind === "preset" || o.kind === "color" || o.kind === "image") && typeof o.value === "string")
      return { kind: o.kind, value: o.value, avg: isRgb(o.avg) ? o.avg : undefined };
  } catch {
    /* malformed — treat as default */
  }
  return null;
}

function isRgb(v: unknown): v is Rgb {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number");
}

function readLook(ws: Workspace): LookPref {
  const raw = localStorage.getItem(lookKey(ws));
  if (!raw) return DEFAULT_LOOK;
  try {
    const o = JSON.parse(raw) as Partial<LookPref>;
    return {
      tone: o.tone === "light" || o.tone === "dark" ? o.tone : "auto",
      opacity: typeof o.opacity === "number" ? Math.min(1, Math.max(0, o.opacity)) : 0,
    };
  } catch {
    return DEFAULT_LOOK;
  }
}

function writeLook(ws: Workspace, look: LookPref): void {
  try {
    localStorage.setItem(lookKey(ws), JSON.stringify(look));
  } catch {
    /* quota — the setting just won't survive a restart */
  }
  applyBackground(ws);
  onLookChange(ws);
}

/**
 * The colour a see-through pane's glyphs actually sit on. Presets and solid
 * colours are known exactly; an uploaded photo is reduced to its mean colour
 * and then darkened by the scrim applyBackground paints over it.
 */
export function backdropRgb(ws: Workspace): Rgb {
  const spec = readSpec(ws);
  if (!spec || spec.kind === "preset") return (PRESETS[spec?.value ?? DEFAULT_KIND] ?? PRESETS[DEFAULT_KIND]).base;
  if (spec.kind === "color") return hexToRgb(spec.value) ?? PRESETS[DEFAULT_KIND].base;
  // An image saved before `avg` existed: assume the scrim dominates, which is
  // true for all but the brightest photos and errs toward light text.
  const mean = spec.avg ?? [128, 128, 128];
  return composite(IMG_SCRIM, mean, IMG_SCRIM_ALPHA);
}

/**
 * How `ws`'s terminals should paint: which way the text reads, how opaque the
 * plate behind it is, and whether the agent CLI's own background gets stripped.
 *
 * The tone is decided from the wallpaper alone, not from the wallpaper plus the
 * plate — the plate colour is itself chosen by the tone, so reading it back
 * would be circular. It stays consistent either way: a light tone paints a dark
 * plate (light text still wins) and a dark tone paints a light one.
 */
export function paneLook(ws: Workspace): PaneLook {
  const pref = readLook(ws);
  const tone = resolveTone(pref.tone, relLuminance(backdropRgb(ws)));
  return {
    theme: paletteFor(tone, pref.opacity),
    // At full opacity the pane is a solid plate again, so the CLI's own
    // background is harmless — leave the stream alone.
    stripPlate: pref.opacity < 1,
  };
}

/** The tone `ws` is currently rendering with — for the CSS hook that gives the
 *  glyphs a legibility floor over a busy photo. */
export function paneTone(ws: Workspace): "light" | "dark" {
  return resolveTone(readLook(ws).tone, relLuminance(backdropRgb(ws)));
}

/** Paint `ws`'s canvas from its saved background (default = the "glow" preset).
 *  Called on every activate, so switching tabs always shows the right one. */
export function applyBackground(ws: Workspace): void {
  const spec = readSpec(ws);
  if (!spec || spec.kind === "preset") {
    const p = PRESETS[spec?.value ?? DEFAULT_KIND] ?? PRESETS[DEFAULT_KIND];
    ws.gridEl.style.background = p.bg;
    ws.gridEl.classList.toggle("sg-grid", p.grid);
  } else {
    ws.gridEl.classList.remove("sg-grid");
    if (spec.kind === "color") {
      ws.gridEl.style.background = spec.value;
    } else {
      // Uploaded image: a dark scrim over cover art keeps the panes legible.
      ws.gridEl.style.background =
        `linear-gradient(rgba(9,10,12,.55),rgba(9,10,12,.62)),url("${spec.value}") center / cover no-repeat`;
    }
  }
  applyPanePlate(ws);
}

/** Hand the pane chrome the same plate the terminal uses, so the frame and the
 *  text agree: at opacity 0 the whole pane is glass and the wallpaper shows
 *  through, and `data-tone` lets the CSS pick a legibility treatment. */
function applyPanePlate(ws: Workspace): void {
  const pref = readLook(ws);
  ws.gridEl.style.setProperty("--pane-plate", paneLook(ws).theme.background);
  ws.gridEl.dataset.tone = paneTone(ws);
  // Glass panes get the blur and the glyph shadow; a solid plate needs neither,
  // and the shadow would only smear text that already has its own backdrop.
  ws.gridEl.dataset.glass = pref.opacity < 0.9 ? "1" : "0";
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
  onLookChange(ws); // a brighter wallpaper can flip the glyphs to dark
  onToast(spec.kind === "image" ? "Background image set" : "Background updated");
}

/** The photo is also drawn this small, purely to measure its mean colour — the
 *  browser's own downscale does the averaging for us. */
const IMG_PROBE_EDGE = 24;

/** Downscale an image File to a JPEG data-URI no larger than IMG_MAX_EDGE, and
 *  measure the mean colour the pane tone will be decided from. */
function fileToScaledDataUri(file: File): Promise<{ uri: string; avg: Rgb }> {
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
      resolve({ uri: canvas.toDataURL("image/jpeg", 0.82), avg: probeMean(img) });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

/** Mean colour of a decoded image, via a 24px thumbnail. Falls back to mid-grey
 *  if the context is unavailable — a neutral guess, not a wrong one. */
function probeMean(img: HTMLImageElement): Rgb {
  const side = IMG_PROBE_EDGE;
  const c = document.createElement("canvas");
  c.width = side;
  c.height = side;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [128, 128, 128];
  ctx.drawImage(img, 0, 0, side, side);
  try {
    return meanRgb(ctx.getImageData(0, 0, side, side).data);
  } catch {
    return [128, 128, 128];
  }
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
  markLook(ws);
}

/** Reflect the workspace's tone/opacity in the Appearance controls. */
function markLook(ws: Workspace | null): void {
  const look = ws ? readLook(ws) : DEFAULT_LOOK;
  document.querySelectorAll<HTMLElement>("#setPaneTone button[data-tone]").forEach((o) => {
    o.classList.toggle("on", o.dataset.tone === look.tone);
  });
  const slider = document.getElementById("paneOpacity") as HTMLInputElement | null;
  if (slider) slider.value = String(Math.round(look.opacity * 100));
  const out = document.getElementById("paneOpacityVal");
  if (out) out.textContent = opacityLabel(look.opacity);
}

/** 0 is the interesting value — say what it means rather than printing "0%". */
function opacityLabel(opacity: number): string {
  return opacity <= 0 ? "Glass" : `${Math.round(opacity * 100)}%`;
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
      const { uri, avg } = await fileToScaledDataUri(file);
      setSpec(ws, { kind: "image", value: uri, avg });
    } catch {
      onToast("Couldn't load that image.");
    }
  });

  document.querySelectorAll<HTMLElement>("#setPaneTone button[data-tone]").forEach((opt) => {
    opt.addEventListener("click", () => {
      const ws = getActiveWs();
      const tone = opt.dataset.tone;
      if (!ws || (tone !== "auto" && tone !== "light" && tone !== "dark")) return;
      writeLook(ws, { ...readLook(ws), tone });
      markLook(ws);
    });
  });

  const opacity = document.getElementById("paneOpacity") as HTMLInputElement | null;
  opacity?.addEventListener("input", () => {
    const ws = getActiveWs();
    if (!ws) return;
    writeLook(ws, { ...readLook(ws), opacity: Number(opacity.value) / 100 });
    markLook(ws);
  });

  // Reflect the active workspace's choice whenever Settings opens.
  document.getElementById("btnSettingsHome")?.addEventListener("click", () => markActive(getActiveWs()));
  document.getElementById("cbSettings")?.addEventListener("click", () => markActive(getActiveWs()));
}
