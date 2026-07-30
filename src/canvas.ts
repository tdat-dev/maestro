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

/**
 * Tile n panes to fill `area` (minus margins). A lone tile ending a short last
 * row stretches to the right.
 *
 * The default gap is 0: tiled panes butt against each other and read as one
 * continuous surface, with the 1px pane border as the only seam. Which is why
 * each tile's size is derived from ROUNDED EDGES rather than a rounded width —
 * rounding x and w independently drifts them apart, and at gap 0 a half-pixel
 * of drift is a visible slit of wallpaper between two panes.
 *
 * `bottom` is breathing room, NOT room for the command bar: `area` is the
 * canvas box, and .main's padding-bottom already reserves the bar's 56px.
 * Reserving it twice cost ~84px — three terminal rows per tile row.
 */
export function tileToFit(n: number, area: Area, opts: TileOpts = {}): Tile[] {
  const gap = opts.gap ?? 0,
    mx = opts.margin ?? 10,
    top = opts.top ?? 10,
    bottom = opts.bottom ?? 10;
  const { cols, rows } = gridDimsFor(n);
  const tw = (area.width - 2 * mx - (cols - 1) * gap) / cols;
  const th = (area.height - top - bottom - (rows - 1) * gap) / rows;
  const out: Tile[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols,
      r = Math.floor(i / cols);
    const left = mx + c * (tw + gap),
      topEdge = top + r * (th + gap);
    const inRow = Math.min(cols, n - r * cols);
    const right = i === n - 1 && inRow < cols ? area.width - mx : left + tw;
    const x = Math.round(left),
      y = Math.round(topEdge);
    out.push({ x, y, w: Math.round(right) - x, h: Math.round(topEdge + th) - y });
  }
  return out;
}

/** First row-major grid position not colliding with `existing` top-lefts. */
export function nextSlot(existing: Pos[], cell: { w: number; h: number; gap?: number }, area: Area): Pos {
  const gap = cell.gap ?? 0;
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
