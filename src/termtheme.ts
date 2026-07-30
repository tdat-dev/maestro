// Terminal colour tone for see-through panes. No DOM — unit-tested in
// termtheme.test.ts.
//
// Once the terminal background goes transparent the glyphs sit directly on the
// workspace wallpaper, so a single hard-coded palette stops working: slate-200
// text is invisible on a white background. We derive the backdrop's relative
// luminance and swap the WHOLE ANSI 16 between a light-text and a dark-text
// palette — swapping only `foreground` leaves bright yellow on white, which is
// unreadable.

/** Which way the text reads: "light" glyphs for dark backdrops, "dark" glyphs
 *  for light ones. */
export type TextTone = "light" | "dark";
/** User setting: follow the backdrop, or pin a tone. */
export type ToneMode = "auto" | TextTone;

export type Rgb = [number, number, number];

/** #rgb / #rrggbb → [r,g,b] (0-255), or null when unparseable. */
export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1];
  if (h.length === 3) {
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Inverse of the sRGB transfer function used by relLuminance. */
function encodeSrgb(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Mean colour of RGBA pixel data, averaged in LINEAR light and re-encoded to
 * sRGB. Averaging the sRGB bytes directly biases the result dark: half white
 * and half black averages to 128, whose luminance is 0.22 — but the light in
 * that image really does average to 0.5, and 0.22 would tell us to paint light
 * text on a photo that is half blazing white. Alpha is ignored; a canvas-decoded
 * wallpaper is opaque.
 */
export function meanRgb(data: ArrayLike<number>): Rgb {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    r += lin(data[i]);
    g += lin(data[i + 1]);
    b += lin(data[i + 2]);
    n++;
  }
  if (!n) return [0, 0, 0];
  return [encodeSrgb(r / n), encodeSrgb(g / n), encodeSrgb(b / n)];
}

/** WCAG contrast ratio between two relative luminances (>= 1). */
export function contrastRatio(a: number, b: number): number {
  const hi = Math.max(a, b),
    lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite `top` over `bottom` at alpha `a` (straight sRGB blend — good
 *  enough for picking a tone, and what the browser paints for a colour scrim
 *  over an image). */
export function composite(top: Rgb, bottom: Rgb, a: number): Rgb {
  const k = Math.min(1, Math.max(0, a));
  return [
    Math.round(k * top[0] + (1 - k) * bottom[0]),
    Math.round(k * top[1] + (1 - k) * bottom[1]),
    Math.round(k * top[2] + (1 - k) * bottom[2]),
  ];
}

/** Backdrop luminance at which light and dark text are equally legible.
 *  Solving 0.82/(L+0.05) = (L+0.05)/0.064 — the contrast of our light
 *  foreground (#e2e8f0, L≈0.77) against the backdrop versus our dark one
 *  (#0f172a, L≈0.014) — gives L+0.05 = sqrt(0.0525), i.e. L ≈ 0.179. Above it
 *  dark text wins, below it light text does. */
export const TONE_THRESHOLD = 0.179;

/** Tone that reads best on a backdrop of this relative luminance. */
export function toneFor(luminance: number): TextTone {
  return luminance >= TONE_THRESHOLD ? "dark" : "light";
}

/** Resolve the user's setting against the measured backdrop. */
export function resolveTone(mode: ToneMode, luminance: number): TextTone {
  return mode === "auto" ? toneFor(luminance) : mode;
}

/** xterm ITheme, structurally — typing it locally keeps this module free of a
 *  runtime import of @xterm/xterm so the tests stay fast. */
export interface TermPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** Light glyphs — the palette Maestro shipped, for dark backdrops. */
const LIGHT_TEXT: Omit<TermPalette, "background"> = {
  foreground: "#e2e8f0", // slate-200
  cursor: "#c6f135", // maestro accent
  cursorAccent: "#0a0c10",
  selectionBackground: "rgba(198, 241, 53, 0.30)",
  black: "#1e293b",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#d946ef",
  cyan: "#06b6d4",
  white: "#f8fafc",
  // Lifted off the old #475569: with no plate behind it, slate-600 "dim" text
  // sat at 2.8:1 on a dark backdrop and disappeared over a photo.
  brightBlack: "#7c8aa0",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fde047",
  brightBlue: "#60a5fa",
  brightMagenta: "#e879f9",
  brightCyan: "#22d3ee",
  brightWhite: "#ffffff",
};

/** Dark glyphs for light backdrops. Every hue is dropped to a 600-800 shade so
 *  it clears 4.5:1 on white — the 400-500 shades a dark theme uses are
 *  unreadable there (yellow-500 on white is 1.7:1, green-600 is 3.3:1). The
 *  normal/bright pair is one step apart, so a CLI that leans on the
 *  distinction still reads. */
const DARK_TEXT: Omit<TermPalette, "background"> = {
  foreground: "#0f172a", // slate-900 — 16.4:1 on white
  cursor: "#4d7c0f", // lime-700: the accent, dark enough to see on white
  cursorAccent: "#f8fafc",
  selectionBackground: "rgba(77, 124, 15, 0.28)",
  black: "#0f172a",
  red: "#991b1b",
  green: "#166534",
  yellow: "#854d0e",
  blue: "#1e40af",
  magenta: "#86198f",
  cyan: "#155e75",
  white: "#334155",
  brightBlack: "#475569",
  brightRed: "#dc2626",
  brightGreen: "#15803d",
  brightYellow: "#a16207",
  brightBlue: "#2563eb",
  brightMagenta: "#c026d3",
  brightCyan: "#0e7490",
  brightWhite: "#020617",
};

/** The plate colour painted behind the glyphs when opacity > 0: near-black
 *  under light text, near-white under dark text. */
const PLATE: Record<TextTone, Rgb> = {
  light: [11, 13, 18], // the old opaque #0b0d12
  dark: [248, 250, 252], // slate-50
};

/**
 * Palette for `tone`, with the background plate at `opacity` (0 = fully
 * see-through, the default; 1 = the opaque terminal Maestro used to draw).
 */
export function paletteFor(tone: TextTone, opacity = 0): TermPalette {
  const a = Math.min(1, Math.max(0, opacity));
  const [r, g, b] = PLATE[tone];
  return {
    // 'rgba(…, 0)' rather than the string 'transparent': xterm parses this into
    // a real colour with a zero alpha channel, whereas 'transparent' is not a
    // colour it accepts everywhere. Needs allowTransparency on the Terminal.
    background: `rgba(${r}, ${g}, ${b}, ${a})`,
    ...(tone === "light" ? LIGHT_TEXT : DARK_TEXT),
  };
}

/** Alpha of a palette's background plate (1 for anything unparseable, i.e.
 *  "assume opaque" — the safe default, since transparency is what needs the
 *  extra care from the renderer). */
export function backgroundAlpha(p: TermPalette): number {
  const m = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)$/.exec(p.background);
  return m ? Number(m[1]) : 1;
}

/** Contrast of a tone's body text against a backdrop — used by the tests to
 *  hold the palettes to the WCAG floor we promised. */
export function foregroundContrast(tone: TextTone, backdrop: number): number {
  const fg = hexToRgb((tone === "light" ? LIGHT_TEXT : DARK_TEXT).foreground)!;
  return contrastRatio(relLuminance(fg), backdrop);
}
