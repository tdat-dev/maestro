/** Terminal-count choices offered by the layout tiles. */
export const TILE_OPTIONS: number[] = [1, 2, 4, 6, 8, 10, 12];

/** Fixed grid shapes for the tile previews; other `n` is computed defensively. */
const TILE_DIMS: Record<number, { cols: number; rows: number }> = {
  1: { cols: 1, rows: 1 },
  2: { cols: 2, rows: 1 },
  4: { cols: 2, rows: 2 },
  6: { cols: 3, rows: 2 },
  8: { cols: 4, rows: 2 },
  10: { cols: 5, rows: 2 },
  12: { cols: 4, rows: 3 },
};

/** Grid shape used to preview `n` terminals: wide-ish, max 4 columns for the
 *  defensive fallback; the tile options use hand-tuned shapes. */
export function gridDims(n: number): { cols: number; rows: number } {
  const fixed = TILE_DIMS[n];
  if (fixed) return fixed;
  let cols = Math.ceil(Math.sqrt(n));
  let rows = Math.ceil(n / cols);
  if (cols < rows) cols = rows;
  rows = Math.ceil(n / cols);
  return { cols, rows };
}

/** Human label for a tile choice, e.g. "1 terminal" / "6 terminals". */
export function countLabel(n: number): string {
  return `${n} terminal${n === 1 ? "" : "s"}`;
}

/** Grid label, e.g. "1×1 grid" / "3×2 grid" (use the × character U+00D7). */
export function gridLabel(n: number): string {
  const { cols, rows } = gridDims(n);
  return `${cols}×${rows} grid`;
}

/** Split `n` terminals across the selected CLI ids, round-robin in the given
 *  order: the first `n % k` ids get one extra. Ids left with 0 terminals (more
 *  models selected than terminals) keep their 0 so the UI can show it. */
export function distributeCounts(n: number, ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (ids.length === 0 || n <= 0) return out;
  ids.forEach((id, i) => {
    out[id] = Math.floor(n / ids.length) + (i < n % ids.length ? 1 : 0);
  });
  return out;
}

/** Clamp a persisted tile choice back to a valid option (default 1). Accepts
 *  numeric strings — localStorage hands values back as strings. */
export function sanitizeCount(v: unknown): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && TILE_OPTIONS.includes(n) ? n : 1;
}
