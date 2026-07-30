import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  angularSpan,
  sigilGeometry,
  coreSidesFor,
  inkFor,
  breathe,
  coreAngle,
  pulseAt,
  sigilAlpha,
  sigilBox,
  tickMode,
  MAX_ALPHA,
  TICK_MS,
  BREATHE_MS,
  CORE_TURN_MS,
  type SigilAgent,
  type TickEnv,
} from "./sigil";
import { tileToFit } from "./canvas";

const TAU = Math.PI * 2;
const AREA = { width: 1200, height: 800 };
const deg = (rad: number) => ((rad * 180) / Math.PI + 360) % 360;

/** n agents laid out exactly as Tidy would lay them out. The sigil's whole
 *  claim is that it reads off the real layout, so the tests feed it the real
 *  tiler rather than hand-written rects. */
function tidied(n: number): SigilAgent[] {
  return tileToFit(n, AREA).map((rect, i) => ({ id: `a${i}`, rect, status: "idle" as const }));
}

describe("angularSpan", () => {
  it("gives each half of a 2-up split its own half of the ring", () => {
    const [left, right] = tidied(2).map((a) => angularSpan(a.rect, AREA.width / 2, AREA.height / 2));
    expect(left.to - left.from).toBeCloseTo(Math.PI, 1);
    expect(right.to - right.from).toBeCloseTo(Math.PI, 1);
    // Together they cover the circle once, with no overlap worth speaking of.
    expect(left.to - left.from + (right.to - right.from)).toBeCloseTo(TAU, 1);
  });

  it("gives each tile of a 2x2 tidy its own quadrant", () => {
    for (const a of tidied(4)) {
      const s = angularSpan(a.rect, AREA.width / 2, AREA.height / 2);
      expect(s.to - s.from).toBeCloseTo(Math.PI / 2, 1);
    }
  });

  it("spans the whole circle when the centre falls inside the rect", () => {
    // One pane filling the canvas: the sigil sits inside it, so it subtends
    // everything. Taking the complement of the largest corner gap is what makes
    // this fall out instead of collapsing to zero.
    const s = angularSpan({ x: 0, y: 0, w: 1200, h: 800 }, 600, 400);
    expect(s.to - s.from).toBeGreaterThan(TAU * 0.95);
  });

  it("returns an arc that always runs forwards", () => {
    // A pane straddling the -x axis has corner angles either side of the ±π
    // wrap; `to` must still come out greater than `from` or the arc draws the
    // long way round the ring.
    const s = angularSpan({ x: 0, y: 350, w: 400, h: 100 }, 600, 400);
    expect(s.to).toBeGreaterThan(s.from);
    expect(s.to - s.from).toBeLessThan(TAU);
  });
});

describe("sigilGeometry", () => {
  it("centres on the grid and nests the rings inwards", () => {
    const g = sigilGeometry(AREA, tidied(4));
    expect(g.cx).toBe(600);
    expect(g.cy).toBe(400);
    expect(g.rOuter).toBeGreaterThan(g.rMid);
    expect(g.rMid).toBeGreaterThan(g.rInner);
    expect(g.rInner).toBeGreaterThan(g.rCore);
  });

  it("scales off the short edge, so a wide window can't push it off-screen", () => {
    const g = sigilGeometry({ width: 3000, height: 600 }, tidied(4));
    expect(g.rOuter).toBeLessThan(300); // half the short edge
  });

  it("points each node at its own pane", () => {
    // 2x2 tidy, row-major: top-left, top-right, bottom-left, bottom-right.
    // Canvas angles: 0 = right, +y = down, so up-left ≈ 225°, up-right ≈ 315°.
    const [tl, tr, bl, br] = sigilGeometry(AREA, tidied(4)).branches.map((b) => deg(b.angle));
    expect(tl).toBeGreaterThan(180);
    expect(tl).toBeLessThan(270);
    expect(tr).toBeGreaterThan(270);
    expect(bl).toBeGreaterThan(90);
    expect(bl).toBeLessThan(180);
    expect(br).toBeLessThan(90);
  });

  it("fans agents out instead of stacking them when a pane is dead centre", () => {
    // atan2(0, 0) is 0 — two full-canvas panes would otherwise share one angle
    // and draw as a single spoke.
    const full = { x: 0, y: 0, w: 1200, h: 800 };
    const g = sigilGeometry(AREA, [
      { id: "a", rect: full, status: "idle" },
      { id: "b", rect: full, status: "idle" },
    ]);
    expect(g.branches[0].angle).not.toBeCloseTo(g.branches[1].angle, 3);
  });

  it("leaves a gap between neighbouring arcs so they read as separate", () => {
    const g = sigilGeometry(AREA, tidied(4));
    for (const b of g.branches) expect(b.to - b.from).toBeLessThan(Math.PI / 2);
  });

  it("keeps a sliver of a pane from inverting into a near-full ring", () => {
    // Insetting a blindly-fixed amount would push `to` below `from` on a very
    // narrow arc, and the drawn arc would wrap the wrong way round the sigil.
    const g = sigilGeometry(AREA, [{ id: "a", rect: { x: 1190, y: 398, w: 2, h: 2 }, status: "idle" }]);
    expect(g.branches[0].to).toBeGreaterThanOrEqual(g.branches[0].from);
    expect(g.branches[0].to - g.branches[0].from).toBeLessThan(0.2);
  });

  it("keeps no branch for a pane the workspace no longer has", () => {
    expect(sigilGeometry(AREA, []).branches).toHaveLength(0);
  });
});

describe("coreSidesFor", () => {
  it("makes the core polygon count the fleet", () => {
    expect(coreSidesFor(2)).toBe(2); // a bare line
    expect(coreSidesFor(3)).toBe(3);
    expect(coreSidesFor(4)).toBe(4);
    expect(coreSidesFor(6)).toBe(6);
  });

  it("stops adding sides once the polygon is a circle anyway", () => {
    expect(coreSidesFor(40)).toBeLessThanOrEqual(12);
  });

  it("has nothing to draw for an empty workspace", () => {
    expect(coreSidesFor(0)).toBe(0);
  });
});

describe("inkFor", () => {
  it("moves only for an agent that is actually working", () => {
    expect(inkFor("active").pulse).toBe(true);
    for (const s of ["needs", "idle", "stopped"] as const) expect(inkFor(s).pulse).toBe(false);
  });

  it("gives waiting-on-you its own pen, loud but still", () => {
    expect(inkFor("needs").pen).toBe("needs");
    expect(inkFor("needs").filled).toBe(true);
  });

  it("greys a stopped agent without erasing it — a dead agent is information", () => {
    const dead = inkFor("stopped");
    expect(dead.pen).toBe("stopped");
    expect(dead.weight).toBeLessThan(inkFor("idle").weight);
    expect(dead.weight).toBeGreaterThan(0);
  });
});

describe("rhythm", () => {
  it("breathes by ±2% and no more", () => {
    for (let t = 0; t < BREATHE_MS * 2; t += 97) {
      expect(breathe(t)).toBeGreaterThanOrEqual(0.98);
      expect(breathe(t)).toBeLessThanOrEqual(1.02);
    }
  });

  it("turns the core once every two minutes, not once a second", () => {
    expect(coreAngle(0)).toBeCloseTo(0, 6);
    expect(coreAngle(CORE_TURN_MS / 2)).toBeCloseTo(Math.PI, 6);
    expect(coreAngle(CORE_TURN_MS - 1)).toBeLessThan(TAU);
  });

  it("staggers the pulses so a busy fleet doesn't beat in unison", () => {
    expect(pulseAt(0, 0)).not.toBeCloseTo(pulseAt(0, 1), 3);
  });

  it("keeps every pulse on its spoke", () => {
    for (let t = 0; t < 9000; t += 53)
      for (let i = 0; i < 6; i++) {
        expect(pulseAt(t, i)).toBeGreaterThanOrEqual(0);
        expect(pulseAt(t, i)).toBeLessThan(1);
      }
  });
});

describe("sigilAlpha", () => {
  // The sigil is drawn UNDER the panes: every stroke shares pixels with
  // terminal glyphs. The ceiling is the only thing standing between "ambient"
  // and "there is a diagram behind my text".
  it("never exceeds the legibility ceiling, whatever it is handed", () => {
    expect(sigilAlpha(1)).toBe(MAX_ALPHA);
    expect(sigilAlpha(4)).toBe(MAX_ALPHA);
    expect(sigilAlpha(-1)).toBe(0);
    // A line drawn behind the text, never a wash over it. Two thirds is where a
    // stroke stops reading as a background and starts competing with a glyph,
    // which carries full-weight ink plus its own legibility shadow.
    expect(MAX_ALPHA).toBeLessThan(0.66);
  });

  it("scales the slider linearly below it", () => {
    expect(sigilAlpha(0.5)).toBeCloseTo(MAX_ALPHA / 2, 6);
  });
});

describe("tickMode", () => {
  const alive: TickEnv = {
    enabled: true,
    visible: true,
    wsActive: true,
    canvasMode: true,
    focusMode: false,
    reducedMotion: false,
    agentCount: 4,
    anyAlive: true,
  };

  it("animates a fleet that is alive and freezes one that is not", () => {
    expect(tickMode(alive)).toBe("live");
    expect(tickMode({ ...alive, anyAlive: false })).toBe("still");
  });

  // There is deliberately no gear between these two. A middle rate — redrawing
  // a few times a second to breathe cheaply — reads as a stutter rather than
  // as slowness, which is the bug that made this a two-state enum.
  it("offers no rate between frozen and smooth", () => {
    const rates = new Set(Object.values(TICK_MS).filter((ms) => Number.isFinite(ms)));
    for (const ms of rates) expect(ms <= 33 || ms >= 1000).toBe(true);
  });

  // Each of these is a way Maestro spends hours: a window behind another, a
  // tab you switched away from, an agent on the focus stage. None of them may
  // leave an animation running.
  it("stops dead — not throttles — whenever nobody can see it", () => {
    expect(tickMode({ ...alive, visible: false })).toBe("off");
    expect(tickMode({ ...alive, wsActive: false })).toBe("off");
    expect(tickMode({ ...alive, canvasMode: false })).toBe("off");
    expect(tickMode({ ...alive, focusMode: true })).toBe("off");
    expect(tickMode({ ...alive, enabled: false })).toBe("off");
    expect(TICK_MS.off).toBe(Infinity);
  });

  it("stops on an empty workspace — there is no fleet to diagram", () => {
    expect(tickMode({ ...alive, agentCount: 0 })).toBe("off");
  });

  it("honours prefers-reduced-motion by drawing, not animating", () => {
    expect(tickMode({ ...alive, reducedMotion: true })).toBe("still");
    // Still redraws occasionally, or a tidy would leave a stale picture — but
    // it is handed a frozen clock, so those frames are identical.
    expect(Number.isFinite(TICK_MS.still)).toBe(true);
    expect(TICK_MS.still).toBeGreaterThan(TICK_MS.live);
  });

  it("caps the working rate below vsync — 30fps is plenty for one pulse", () => {
    expect(TICK_MS.live).toBeGreaterThanOrEqual(30);
  });
});

describe("sigilBox", () => {
  it("centres the box on the area", () => {
    // Within a pixel: the position is rounded and the size ceil'd so the canvas
    // lands on whole device pixels, which can leave the centre half a pixel off.
    const b = sigilBox(AREA);
    expect(Math.abs(b.x + b.size / 2 - AREA.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.y + b.size / 2 - AREA.height / 2)).toBeLessThanOrEqual(1);
  });

  it("is much smaller than the grid — that is the whole point of it", () => {
    // Sizing the canvas to the drawing rather than to the grid is what pays for
    // animating on rAF instead of on a timer. If this ever creeps up to the
    // full grid, the cost of a frame roughly doubles.
    const b = sigilBox({ width: 1936, height: 1096 });
    expect(b.size * b.size).toBeLessThan(1936 * 1096 * 0.5);
  });

  it("still contains the drawing, ticks and all", () => {
    const g = sigilGeometry(AREA, tidied(4));
    const b = sigilBox(AREA);
    // The major ticks reach past rOuter; the box has to cover them or the ruler
    // gets clipped at the canvas edge.
    expect(b.size / 2).toBeGreaterThan(g.rOuter);
  });

  it("never spills past the short edge, however wide the window", () => {
    for (const area of [{ width: 3000, height: 600 }, { width: 600, height: 3000 }, AREA]) {
      const b = sigilBox(area);
      expect(b.size).toBeLessThanOrEqual(Math.min(area.width, area.height));
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
    }
  });
});

// The sigil only exists because it can be seen THROUGH the panes. Its stacking
// order is therefore load-bearing, not cosmetic: one z-index typo and it either
// vanishes under the wallpaper or paints over the terminal text.
describe("sigil stacking (canvas.css)", () => {
  const css = readFileSync("src/styles/canvas.css", "utf8");
  const rule = (selector: string): string => {
    const m = css.match(
      new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m"),
    );
    return m?.[1] ?? "";
  };
  const z = (selector: string): number => Number(rule(selector).match(/z-index:\s*(\d+)/)?.[1] ?? NaN);

  it("sits above the wallpaper and below the panes", () => {
    expect(z(".grid.canvas > canvas.sigil")).toBeGreaterThan(z(".grid.canvas.sg-grid::before"));
    expect(z(".grid.canvas > canvas.sigil")).toBeLessThan(z(".grid.canvas .pane"));
  });

  it("never eats a click meant for a pane", () => {
    expect(rule(".grid.canvas > canvas.sigil")).toMatch(/pointer-events:\s*none/);
  });

  it("is hidden behind the focus stage's scrim", () => {
    expect(rule(".grid.canvas.has-focus > canvas.sigil")).toMatch(/display:\s*none/);
  });
});
