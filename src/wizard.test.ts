import { describe, it, expect } from "vitest";
import { TILE_OPTIONS, gridDims, countLabel, gridLabel, distributeCounts, sanitizeCount } from "./wizard";

describe("TILE_OPTIONS", () => {
  it("offers the seven tile choices", () => {
    expect(TILE_OPTIONS).toEqual([1, 2, 4, 6, 8, 10, 12]);
  });
});

describe("gridDims", () => {
  it("maps every tile option to its preview shape", () => {
    expect(gridDims(1)).toEqual({ cols: 1, rows: 1 });
    expect(gridDims(2)).toEqual({ cols: 2, rows: 1 });
    expect(gridDims(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridDims(6)).toEqual({ cols: 3, rows: 2 });
    expect(gridDims(8)).toEqual({ cols: 4, rows: 2 });
    expect(gridDims(10)).toEqual({ cols: 5, rows: 2 });
    expect(gridDims(12)).toEqual({ cols: 4, rows: 3 });
  });
  it("computes a defensive shape for non-tile counts", () => {
    for (const n of [3, 5, 7, 9, 11, 13, 20]) {
      const { cols, rows } = gridDims(n);
      expect(cols * rows).toBeGreaterThanOrEqual(n);
      expect(cols).toBeGreaterThanOrEqual(rows);
    }
  });
});

describe("countLabel", () => {
  it("is singular for one terminal", () => {
    expect(countLabel(1)).toBe("1 terminal");
  });
  it("is plural for more than one", () => {
    expect(countLabel(2)).toBe("2 terminals");
    expect(countLabel(6)).toBe("6 terminals");
  });
});

describe("gridLabel", () => {
  it("labels every tile option with the × character", () => {
    expect(gridLabel(1)).toBe("1×1 grid");
    expect(gridLabel(2)).toBe("2×1 grid");
    expect(gridLabel(4)).toBe("2×2 grid");
    expect(gridLabel(6)).toBe("3×2 grid");
    expect(gridLabel(8)).toBe("4×2 grid");
    expect(gridLabel(10)).toBe("5×2 grid");
    expect(gridLabel(12)).toBe("4×3 grid");
  });
});

describe("distributeCounts", () => {
  it("gives every terminal to a single selected model", () => {
    expect(distributeCounts(4, ["claude"])).toEqual({ claude: 4 });
  });
  it("splits evenly when the count divides", () => {
    expect(distributeCounts(4, ["claude", "codex"])).toEqual({ claude: 2, codex: 2 });
    expect(distributeCounts(6, ["claude", "codex", "gemini"])).toEqual({ claude: 2, codex: 2, gemini: 2 });
  });
  it("hands the remainder to the first ids", () => {
    expect(distributeCounts(6, ["claude", "codex", "gemini", "aider"])).toEqual({ claude: 2, codex: 2, gemini: 1, aider: 1 });
    expect(distributeCounts(1, ["claude", "codex"])).toEqual({ claude: 1, codex: 0 });
  });
  it("keeps zero shares visible when models outnumber terminals", () => {
    expect(distributeCounts(2, ["claude", "codex", "gemini"])).toEqual({ claude: 1, codex: 1, gemini: 0 });
  });
  it("is empty with no selection or no terminals", () => {
    expect(distributeCounts(4, [])).toEqual({});
    expect(distributeCounts(0, ["claude"])).toEqual({});
  });
});

describe("sanitizeCount", () => {
  it("keeps a valid tile option", () => {
    expect(sanitizeCount(4)).toBe(4);
    expect(sanitizeCount(12)).toBe(12);
  });
  it("accepts numeric strings (localStorage round-trip)", () => {
    expect(sanitizeCount("4")).toBe(4);
    expect(sanitizeCount("12")).toBe(12);
  });
  it("falls back to 1 for out-of-set numbers", () => {
    expect(sanitizeCount(3)).toBe(1);
    expect(sanitizeCount(0)).toBe(1);
    expect(sanitizeCount(100)).toBe(1);
  });
  it("falls back to 1 for junk inputs", () => {
    expect(sanitizeCount("junk")).toBe(1);
    expect(sanitizeCount("")).toBe(1);
    expect(sanitizeCount(null)).toBe(1);
    expect(sanitizeCount(undefined)).toBe(1);
    expect(sanitizeCount({})).toBe(1);
    expect(sanitizeCount(NaN)).toBe(1);
  });
});
