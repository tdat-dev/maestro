// Strip the *plate* an agent CLI paints behind itself, so a see-through pane
// really shows only glyphs over the wallpaper. No DOM — unit-tested in
// ansibg.test.ts.
//
// Making the terminal background transparent only clears cells that use the
// DEFAULT background. A TUI that paints its own charcoal backdrop (opencode /
// OpenTUI fills the whole screen; Claude Code fills its prompt box and status
// line) still draws an opaque rectangle over the image. Remapping those colours
// to transparent in the xterm palette is not an option: the same palette entry
// is used for FOREGROUND, so knocking out "black" also erases black text —
// exactly the text we need on a light background.
//
// So we edit the byte stream instead, dropping only the SGR parameters that SET
// A BACKGROUND to a dark neutral. Foreground colours are never touched, and a
// meaningful coloured background survives: a diff's dark green (#12261a) has
// enough chroma to be kept, while a flat charcoal (#1e1e1e) does not.

/** Below this relative luminance a background counts as "dark". */
export const BG_DARK_MAX = 0.12;
/** Max channel spread (0-255) for a colour to count as neutral — a dark diff
 *  green sits around 20 and is kept; a grey plate is 0-6 and is dropped. */
export const BG_NEUTRAL_SPREAD = 12;

/** The xterm-256 grayscale ramp runs 232 (#080808) → 255 (#eeeeee). Only the
 *  dark half is plate material; past this the grey is a real UI surface. */
const GRAY_RAMP_DARK_END = 240; // #4e4e4e

const SGR_DEFAULT_BG = "49";

function lum(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** A dark, near-neutral colour is a background plate rather than information. */
export function isPlateColor(r: number, g: number, b: number): boolean {
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return spread <= BG_NEUTRAL_SPREAD && lum(r, g, b) < BG_DARK_MAX;
}

/** Colour n of the xterm-256 palette, as RGB. */
export function xterm256(n: number): [number, number, number] {
  if (n < 16) {
    // The 16 ANSI slots are themeable, so judge them by the classic values —
    // that is what a CLI assumes when it paints with them.
    const base: [number, number, number][] = [
      [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
      [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
      [64, 64, 64], [255, 0, 0], [0, 255, 0], [255, 255, 0],
      [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ];
    return base[n];
  }
  if (n < 232) {
    const i = n - 16;
    const step = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return [step(Math.floor(i / 36)), step(Math.floor(i / 6) % 6), step(i % 6)];
  }
  const v = 8 + (n - 232) * 10;
  return [v, v, v];
}

function plateAt256(n: number): boolean {
  if (n >= 232) return n <= GRAY_RAMP_DARK_END;
  const [r, g, b] = xterm256(n);
  return isPlateColor(r, g, b);
}

/**
 * Rewrite one SGR parameter list, replacing every plate background with a
 * reset-to-default (49). Returns the input unchanged when nothing matched, so
 * the caller can skip re-encoding.
 *
 * Handles `40-47`, `100-107`, `48;5;n` and `48;2;r;g;b`, including the colon
 * sub-parameter form (`48:5:n`) some programs emit.
 */
export function rewriteSgr(params: string): string {
  const parts = params.split(";");
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i];
    // Colon form carries the whole colour in one token.
    if (tok.startsWith("48:")) {
      const sub = tok.split(":");
      if (dropsColonBg(sub)) {
        out.push(SGR_DEFAULT_BG);
        changed = true;
      } else out.push(tok);
      continue;
    }
    const n = Number(tok);
    if (!Number.isInteger(n)) {
      out.push(tok);
      continue;
    }
    // Indexed background: 40-47 → ANSI 0-7, 100-107 → ANSI 8-15.
    if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) {
      const idx = n >= 100 ? n - 100 + 8 : n - 40;
      if (plateAt256(idx)) {
        out.push(SGR_DEFAULT_BG);
        changed = true;
      } else out.push(tok);
      continue;
    }
    if (n === 48) {
      const mode = Number(parts[i + 1]);
      if (mode === 5 && i + 2 < parts.length) {
        const c = Number(parts[i + 2]);
        if (Number.isInteger(c) && plateAt256(c)) {
          out.push(SGR_DEFAULT_BG);
          changed = true;
        } else out.push(tok, parts[i + 1], parts[i + 2]);
        i += 2;
        continue;
      }
      if (mode === 2 && i + 4 < parts.length) {
        const r = Number(parts[i + 2]),
          g = Number(parts[i + 3]),
          b = Number(parts[i + 4]);
        if ([r, g, b].every(Number.isInteger) && isPlateColor(r, g, b)) {
          out.push(SGR_DEFAULT_BG);
          changed = true;
        } else out.push(tok, parts[i + 1], parts[i + 2], parts[i + 3], parts[i + 4]);
        i += 4;
        continue;
      }
      out.push(tok);
      continue;
    }
    out.push(tok);
  }
  return changed ? out.join(";") : params;
}

function dropsColonBg(sub: string[]): boolean {
  const mode = Number(sub[1]);
  if (mode === 5) {
    const c = Number(sub[2]);
    return Number.isInteger(c) && plateAt256(c);
  }
  if (mode === 2) {
    // 48:2::r:g:b — an empty colour-space slot is legal, so read from the end.
    const tail = sub.slice(-3).map(Number);
    return tail.length === 3 && tail.every(Number.isInteger) && isPlateColor(tail[0], tail[1], tail[2]);
  }
  return false;
}

const ESC = 0x1b,
  BRACKET = 0x5b,
  FINAL_M = 0x6d;
/** A CSI longer than this is malformed; flush it rather than buffer forever. */
const MAX_PENDING = 64;

/**
 * Streaming filter over raw PTY bytes. An escape sequence can be split across
 * chunks, so an incomplete CSI tail is carried to the next call. Safe against
 * UTF-8: every byte a CSI is made of is < 0x80, and continuation bytes are
 * >= 0x80, so a multi-byte character can never be mistaken for one.
 *
 * `enabled` is read per chunk rather than captured, so the caller can toggle
 * stripping at runtime. Turning it off must go through here too — bytes carried
 * from a previous chunk would otherwise be stranded and never reach the screen.
 */
export function createBgFilter(enabled: () => boolean = () => true): (chunk: Uint8Array) => Uint8Array {
  let pending: number[] = [];
  const enc = new TextEncoder();

  return (chunk: Uint8Array): Uint8Array => {
    if (!enabled()) {
      if (!pending.length) return chunk;
      const flushed = Uint8Array.from([...pending, ...chunk]);
      pending = [];
      return flushed;
    }
    const src = pending.length ? Uint8Array.from([...pending, ...chunk]) : chunk;
    pending = [];
    // Never grows: '49' is no longer than any background parameter it replaces.
    const out = new Uint8Array(src.length);
    let w = 0;
    let i = 0;
    while (i < src.length) {
      if (src[i] !== ESC || i + 1 >= src.length) {
        if (src[i] === ESC) {
          pending = [src[i]]; // lone ESC at the boundary — decide next chunk
          break;
        }
        out[w++] = src[i++];
        continue;
      }
      if (src[i + 1] !== BRACKET) {
        out[w++] = src[i++];
        out[w++] = src[i++];
        continue;
      }
      // CSI: scan to the final byte (0x40-0x7e).
      let j = i + 2;
      while (j < src.length && src[j] < 0x40) j++;
      if (j >= src.length) {
        if (j - i <= MAX_PENDING) {
          pending = Array.from(src.subarray(i)); // incomplete — carry it
          break;
        }
        for (; i < src.length; i++) out[w++] = src[i];
        break;
      }
      if (src[j] !== FINAL_M) {
        for (let k = i; k <= j; k++) out[w++] = src[k];
        i = j + 1;
        continue;
      }
      const params = String.fromCharCode(...src.subarray(i + 2, j));
      const next = rewriteSgr(params);
      if (next === params) {
        for (let k = i; k <= j; k++) out[w++] = src[k];
      } else {
        out[w++] = ESC;
        out[w++] = BRACKET;
        const bytes = enc.encode(next);
        out.set(bytes, w);
        w += bytes.length;
        out[w++] = FINAL_M;
      }
      i = j + 1;
    }
    return out.subarray(0, w);
  };
}
