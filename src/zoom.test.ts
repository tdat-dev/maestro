import { describe, it, expect } from "vitest";
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  FONT_MIN,
  FONT_MAX,
  clampZoom,
  stepZoom,
  effectiveFont,
  zoomLabel,
  autoFitRows,
} from "./zoom";

describe("clampZoom", () => {
  it("holds the ends", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(1)).toBe(1);
  });

  it("survives junk from localStorage", () => {
    // getZoom does Number(raw) on whatever is in storage; a corrupted entry
    // must fall back to 100%, not NaN its way into the font maths.
    expect(clampZoom(Number("nope"))).toBe(1);
    expect(clampZoom(Infinity)).toBe(1);
  });

  it("rounds off float dust so the label is stable", () => {
    expect(clampZoom(0.1 + 0.2 + 0.7)).toBe(1);
  });
});

describe("stepZoom", () => {
  it("moves one notch each way", () => {
    expect(stepZoom(1, 1)).toBeCloseTo(1 + ZOOM_STEP, 5);
    expect(stepZoom(1, -1)).toBeCloseTo(1 - ZOOM_STEP, 5);
  });

  it("snaps an off-grid zoom back onto the step grid", () => {
    // An off-grid value that never lands on a clean 100% again is the failure
    // mode this rounding exists to prevent: from 1.07, one notch down must be
    // exactly 1, not 0.97.
    expect(stepZoom(1.07, -1)).toBe(1);
    expect(stepZoom(1.03, 1)).toBeCloseTo(1.1, 5);
    // And the step still moves — snapping never swallows the notch.
    expect(stepZoom(1.03, -1)).toBeCloseTo(0.9, 5);
  });

  it("stops at the ends instead of drifting past them", () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });

  it("walks from one end to the other and back on clean steps", () => {
    let z = ZOOM_MIN;
    for (let i = 0; i < 50; i++) z = stepZoom(z, 1);
    expect(z).toBe(ZOOM_MAX);
    for (let i = 0; i < 50; i++) z = stepZoom(z, -1);
    expect(z).toBe(ZOOM_MIN);
  });
});

describe("effectiveFont", () => {
  it("scales the base size", () => {
    expect(effectiveFont(14, 1)).toBe(14);
    expect(effectiveFont(14, 1.5)).toBe(21);
    expect(effectiveFont(14, 0.6)).toBe(8);
  });

  it("returns whole pixels", () => {
    expect(Number.isInteger(effectiveFont(13, 1.1))).toBe(true);
  });

  it("holds the legible range even at the extremes", () => {
    expect(effectiveFont(10, ZOOM_MIN)).toBeGreaterThanOrEqual(FONT_MIN);
    expect(effectiveFont(20, ZOOM_MAX)).toBeLessThanOrEqual(FONT_MAX);
  });
});

describe("zoomLabel", () => {
  it("reads as a percentage", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(0.6)).toBe("60%");
    expect(zoomLabel(1.7)).toBe("170%");
  });
});

describe("autoFitRows", () => {
  it("keeps the row floor while the user has said nothing", () => {
    expect(autoFitRows(24, 1)).toBe(24);
  });

  it("stands down once the user zooms — either way", () => {
    // Zoomed in, auto-fit would claw back the size the user just asked for;
    // zoomed out, it would refuse the density they just asked for.
    expect(autoFitRows(24, 1.2)).toBe(0);
    expect(autoFitRows(24, 0.8)).toBe(0);
  });

  it("treats a hair off 100% as 100%", () => {
    // clampZoom's rounding is what makes this comparison safe against float
    // dust accumulated by a long wheel gesture.
    expect(autoFitRows(24, 0.1 + 0.2 + 0.7)).toBe(24);
  });
});
