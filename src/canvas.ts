// Pure geometry for the pane canvas: grid-to-fit tiling, free-slot packing,
// and layout (de)serialization. No DOM — unit-tested in canvas.test.ts.

export type Pos = { x: number; y: number };
export type Tile = { x: number; y: number; w: number; h: number };
export type Area = { width: number; height: number };
export type TileOpts = { gap?: number; margin?: number; top?: number; bottom?: number };

/** Squarish grid: 2→2x1 (big side by side), 4→2x2, 6→3x2, … */
export function gridDimsFor(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  return { cols, rows };
}

/** Tile n panes to fill `area` (minus margins + a reserved bottom band for the
 *  command bar). A lone tile ending a short last row stretches to the right. */
export function tileToFit(n: number, area: Area, opts: TileOpts = {}): Tile[] {
  const gap = opts.gap ?? 12,
    mx = opts.margin ?? 18,
    top = opts.top ?? 16,
    bottom = opts.bottom ?? 84;
  const { cols, rows } = gridDimsFor(n);
  const tw = (area.width - 2 * mx - (cols - 1) * gap) / cols;
  const th = (area.height - top - bottom - (rows - 1) * gap) / rows;
  const out: Tile[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols,
      r = Math.floor(i / cols);
    const x = mx + c * (tw + gap),
      y = top + r * (th + gap);
    const inRow = Math.min(cols, n - r * cols);
    const w = i === n - 1 && inRow < cols ? area.width - mx - x : tw;
    out.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(th) });
  }
  return out;
}

/** First row-major grid position not colliding with `existing` top-lefts. */
export function nextSlot(existing: Pos[], cell: { w: number; h: number; gap?: number }, area: Area): Pos {
  const gap = cell.gap ?? 12;
  const stepX = cell.w + gap,
    stepY = cell.h + gap;
  const cols = Math.max(1, Math.floor((area.width + gap) / stepX));
  const taken = new Set(existing.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
  for (let i = 0; i < 4096; i++) {
    const c = i % cols,
      r = Math.floor(i / cols);
    const x = c * stepX,
      y = r * stepY;
    if (!taken.has(`${x},${y}`)) return { x, y };
  }
  return { x: 0, y: 0 };
}

export function serializeLayout(map: Record<string, Tile>): string {
  return JSON.stringify(map);
}

export function parseLayout(raw: string | null): Record<string, Tile> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, Tile>) : {};
  } catch {
    return {};
  }
}
