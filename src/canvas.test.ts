import { describe, it, expect } from "vitest";
import { gridDimsFor, tileToFit, nextSlot, serializeLayout, parseLayout } from "./canvas";

describe("gridDimsFor", () => {
  it("keeps 2 panes side by side, 4 in a 2x2", () => {
    expect(gridDimsFor(1)).toEqual({ cols: 1, rows: 1 });
    expect(gridDimsFor(2)).toEqual({ cols: 2, rows: 1 });
    expect(gridDimsFor(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridDimsFor(6)).toEqual({ cols: 3, rows: 2 });
  });
});

describe("tileToFit", () => {
  const area = { width: 1000, height: 800 };
  it("returns one tile per pane, none overlapping, all inside the area", () => {
    const tiles = tileToFit(4, area, { gap: 10, margin: 10, top: 10, bottom: 80 });
    expect(tiles).toHaveLength(4);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(10);
      expect(t.y).toBeGreaterThanOrEqual(10);
      expect(t.x + t.w).toBeLessThanOrEqual(area.width - 10 + 0.5);
      expect(t.y + t.h).toBeLessThanOrEqual(area.height - 80 + 0.5);
    }
  });
  it("stretches a lone last tile to fill the rest of its row", () => {
    const tiles = tileToFit(3, area, { gap: 10, margin: 10, top: 10, bottom: 10 });
    expect(tiles[2].w).toBeGreaterThan(tiles[0].w + 1);
  });
});

describe("nextSlot", () => {
  it("packs row-major and avoids an occupied first cell", () => {
    const area = { width: 1000, height: 800 };
    const cell = { w: 300, h: 200, gap: 12 };
    expect(nextSlot([], cell, area)).toEqual({ x: 0, y: 0 });
    const p2 = nextSlot([{ x: 0, y: 0 }], cell, area);
    expect(p2.x).toBe(312);
    expect(p2.y).toBe(0);
  });
});

describe("serializeLayout / parseLayout", () => {
  it("round-trips and tolerates a corrupt string", () => {
    const map = { a: { x: 1, y: 2, w: 3, h: 4 } };
    expect(parseLayout(serializeLayout(map))).toEqual(map);
    expect(parseLayout(null)).toEqual({});
    expect(parseLayout("{not json")).toEqual({});
  });
});
