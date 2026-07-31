import { describe, it, expect } from "vitest";
import {
  hexToRgb,
  relLuminance,
  contrastRatio,
  composite,
  meanRgb,
  toneFor,
  resolveTone,
  paletteFor,
  foregroundContrast,
  TONE_THRESHOLD,
  type TermPalette,
} from "./termtheme";

const WHITE = relLuminance([255, 255, 255]);
const BLACK = relLuminance([0, 0, 0]);

describe("hexToRgb", () => {
  it("reads both the short and long form, and rejects junk", () => {
    expect(hexToRgb("#fff")).toEqual([255, 255, 255]);
    expect(hexToRgb("0f172a")).toEqual([15, 23, 42]);
    expect(hexToRgb("#c6f135")).toEqual([198, 241, 53]);
    expect(hexToRgb("rgb(1,2,3)")).toBeNull();
  });
});

describe("relLuminance", () => {
  it("anchors at black and white", () => {
    expect(BLACK).toBeCloseTo(0, 5);
    expect(WHITE).toBeCloseTo(1, 5);
  });
});

describe("toneFor", () => {
  it("picks dark text on light backdrops and light text on dark ones", () => {
    expect(toneFor(WHITE)).toBe("dark");
    expect(toneFor(BLACK)).toBe("light");
    expect(toneFor(relLuminance([255, 255, 255]))).toBe("dark");
    expect(toneFor(relLuminance([10, 12, 18]))).toBe("light");
  });
  it("flips exactly at the equal-legibility threshold", () => {
    expect(toneFor(TONE_THRESHOLD)).toBe("dark");
    expect(toneFor(TONE_THRESHOLD - 0.001)).toBe("light");
  });
});

describe("resolveTone", () => {
  it("honours a pinned tone over the backdrop", () => {
    expect(resolveTone("auto", WHITE)).toBe("dark");
    expect(resolveTone("light", WHITE)).toBe("light");
    expect(resolveTone("dark", BLACK)).toBe("dark");
  });
});

describe("composite", () => {
  it("blends a scrim over an image the way the browser paints it", () => {
    expect(composite([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
    expect(composite([9, 10, 12], [255, 255, 255], 0)).toEqual([255, 255, 255]);
    expect(composite([9, 10, 12], [255, 255, 255], 1)).toEqual([9, 10, 12]);
  });
});

describe("meanRgb", () => {
  const px = (...pixels: Array<[number, number, number]>) =>
    pixels.flatMap(([r, g, b]) => [r, g, b, 255]);

  it("returns the colour itself for a flat image", () => {
    expect(meanRgb(px([200, 100, 50], [200, 100, 50]))).toEqual([200, 100, 50]);
  });

  it("averages light, not bytes — and that changes the tone decision", () => {
    // A quarter blazing white, three quarters black. The light really does
    // average to 0.25, which wants dark text; averaging the bytes gives 64,
    // reads as 0.05, and would paint white glyphs onto the white quarter.
    const quarterWhite = px([255, 255, 255], [0, 0, 0], [0, 0, 0], [0, 0, 0]);
    expect(meanRgb(quarterWhite)[0]).toBeGreaterThan(130);
    expect(toneFor(relLuminance(meanRgb(quarterWhite)))).toBe("dark");
    expect(toneFor(relLuminance([64, 64, 64]))).toBe("light");
  });

  it("survives empty data", () => {
    expect(meanRgb([])).toEqual([0, 0, 0]);
  });
});

describe("paletteFor", () => {
  it("is fully transparent by default and opaque at 1", () => {
    expect(paletteFor("light").background).toBe("rgba(11, 13, 18, 0)");
    expect(paletteFor("light", 1).background).toBe("rgba(11, 13, 18, 1)");
    // the dark-text plate is light, so a half-opaque pane stays readable
    expect(paletteFor("dark", 0.5).background).toBe("rgba(248, 250, 252, 0.5)");
  });

  it("swaps the WHOLE ansi 16, not just the foreground", () => {
    const light = paletteFor("light");
    const dark = paletteFor("dark");
    const keys = Object.keys(light).filter((k) => k !== "background") as (keyof TermPalette)[];
    for (const k of keys) expect(dark[k], `${k} must differ between tones`).not.toBe(light[k]);
  });

  it("keeps every text-carrying ansi colour legible on its own backdrop", () => {
    // The point of the swap: on white, the light palette's yellow is 1.7:1.
    // `black` is exempt — ANSI black on a dark backdrop is invisible in every
    // terminal ever shipped, and `cursorAccent` is the glyph UNDER the cursor
    // block, so it has to contrast with `cursor`, not with the backdrop.
    const exempt = new Set(["background", "black", "cursorAccent"]);
    const backdrops: Array<["light" | "dark", number]> = [
      ["light", BLACK],
      ["dark", WHITE],
    ];
    for (const [tone, backdrop] of backdrops) {
      const p = paletteFor(tone);
      for (const [name, hex] of Object.entries(p)) {
        if (exempt.has(name) || hex.startsWith("rgba")) continue;
        const ratio = contrastRatio(relLuminance(hexToRgb(hex)!), backdrop);
        expect(ratio, `${tone}/${name} (${hex}) = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the cursor block readable — its glyph contrasts with the cursor", () => {
    for (const tone of ["light", "dark"] as const) {
      const p = paletteFor(tone);
      const ratio = contrastRatio(
        relLuminance(hexToRgb(p.cursor)!),
        relLuminance(hexToRgb(p.cursorAccent)!),
      );
      expect(ratio, `${tone} cursor/cursorAccent = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("foregroundContrast", () => {
  it("clears the 7:1 body-text target on the backdrops each tone is for", () => {
    expect(foregroundContrast("dark", WHITE)).toBeGreaterThanOrEqual(7);
    expect(foregroundContrast("light", BLACK)).toBeGreaterThanOrEqual(7);
  });
  it("shows why the swap is needed — the wrong tone fails badly", () => {
    expect(foregroundContrast("light", WHITE)).toBeLessThan(3);
    expect(foregroundContrast("dark", BLACK)).toBeLessThan(3);
  });
});
