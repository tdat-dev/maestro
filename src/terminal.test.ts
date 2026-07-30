import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mountTerminal, decodeOsc52, shrinkToFit, AUTO_FIT_MIN } from "./terminal";

// Smoke test: verifies the module (and its @xterm + CSS imports) resolves and
// compiles under the bundler. Real terminal rendering needs a browser and is
// verified manually in the running Tauri app (see M0 plan Task 11/12).
describe("terminal module", () => {
  it("exports mountTerminal as a function", () => {
    expect(typeof mountTerminal).toBe("function");
  });
});

// OSC 52 payloads as they arrive at the parser handler: everything after
// "52;" — i.e. "<targets>;<base64>". Claude Code emits "c;<base64>".
describe("decodeOsc52", () => {
  it("decodes a Claude Code copy sequence", () => {
    expect(decodeOsc52(`c;${btoa("hello world")}`)).toBe("hello world");
  });

  it("decodes multi-byte UTF-8 (Vietnamese)", () => {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode("bôi đen")));
    expect(decodeOsc52(`c;${b64}`)).toBe("bôi đen");
  });

  it("accepts other/empty target lists", () => {
    expect(decodeOsc52(`;${btoa("x")}`)).toBe("x");
    expect(decodeOsc52(`ps;${btoa("x")}`)).toBe("x");
  });

  it("refuses the '?' query form (would leak the clipboard)", () => {
    expect(decodeOsc52("c;?")).toBeNull();
  });

  it("refuses empty and malformed payloads", () => {
    expect(decodeOsc52("c;")).toBeNull();
    expect(decodeOsc52("c")).toBeNull();
    expect(decodeOsc52("c;***not-base64***")).toBeNull();
    expect(decodeOsc52(`c;${btoa("")}`)).toBeNull();
  });
});

// Auto-fit: a tiled pane trades font size for rows so the agent CLI's chrome
// (prompt box + status line, ~7 rows) doesn't consume the whole viewport.
describe("shrinkToFit", () => {
  // Rows a pane of `px` usable height renders at `size`, xterm-style: the cell
  // is the font size times the 1.2 line-height, rounded up.
  const paneOf = (px: number) => (size: number) => Math.floor(px / Math.ceil(size * 1.2));

  it("leaves a roomy pane at the base size", () => {
    expect(shrinkToFit(20, AUTO_FIT_MIN, 24, paneOf(760))).toBe(20);
  });

  it("shrinks a 2x2 tile until it clears the row floor", () => {
    // ~360px is what a tile gets on a 2x2 tidy: 20px font renders 15 rows.
    const size = shrinkToFit(20, AUTO_FIT_MIN, 24, paneOf(360));
    expect(size).toBeLessThan(20);
    expect(paneOf(360)(size)).toBeGreaterThanOrEqual(24);
  });

  it("stops at the floor instead of shrinking to nothing", () => {
    expect(shrinkToFit(20, AUTO_FIT_MIN, 24, paneOf(120))).toBe(AUTO_FIT_MIN);
  });

  it("measures the size it returns last, so the caller need not re-apply it", () => {
    const seen: number[] = [];
    const size = shrinkToFit(20, AUTO_FIT_MIN, 24, (n) => {
      seen.push(n);
      return paneOf(120)(n);
    });
    expect(seen[seen.length - 1]).toBe(size);
  });

  it("never grows past the base — a roomy pane keeps a small base small", () => {
    expect(shrinkToFit(AUTO_FIT_MIN + 1, AUTO_FIT_MIN, 24, paneOf(760))).toBe(AUTO_FIT_MIN + 1);
  });

  it("clamps a base under the floor up to it rather than below", () => {
    expect(shrinkToFit(AUTO_FIT_MIN - 2, AUTO_FIT_MIN, 24, paneOf(760))).toBe(AUTO_FIT_MIN);
  });
});

// Layout contract with @xterm/addon-fit. fit() proposes rows/cols from the
// PARENT's height/width and only subtracts padding declared on `.xterm` itself
// (see proposeDimensions in addon-fit). Padding on the parent is therefore
// invisible to it: it proposes rows that don't fit, and .pane's overflow:hidden
// slices the last line in half — which is exactly what shipped (a 399px host
// with a 22px cell got 18 rows instead of 16, clipping "auto mode on…").
// jsdom has no layout engine, so the regression is guarded at the CSS level.
describe("terminal host layout (addon-fit contract)", () => {
  // Read off disk, not `import ...?raw`: vitest stubs every CSS module to an
  // empty string unless `test.css` is on. Path is relative to the repo root,
  // where vitest runs.
  const css = readFileSync("src/styles/workspace.css", "utf8");
  const rule = (selector: string): string => {
    const m = css.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m"));
    return m?.[1] ?? "";
  };

  it("keeps the terminal host free of padding", () => {
    expect(rule(".term-host")).not.toMatch(/(^|;)\s*padding/);
  });

  it("puts the inset on .xterm, where fit() accounts for it", () => {
    expect(rule(".term-host .xterm")).toMatch(/padding:/);
  });

  it("fades exactly the top inset — a longer fade would grey out the first row", () => {
    const fade = rule(".term-host").match(/mask-image:linear-gradient\(180deg,transparent,#000 (\d+)px\)/);
    const padTop = rule(".term-host .xterm").match(/padding:\s*(\d+)px/);
    expect(fade?.[1]).toBe(padTop?.[1]);
  });

  it("fades only the padding strip, not whole rows of text", () => {
    // A percentage stop scales with the pane: 11% of a 399px host erased ~2
    // rows of output at the top. An absolute stop can only ever cover the inset.
    const host = rule(".term-host");
    expect(host).toMatch(/mask-image:/);
    expect(host).not.toMatch(/mask-image:[^;]*\d+%/);
  });

  // See-through panes are the whole point of the canvas wallpaper, and xterm
  // ships a rule that quietly defeats them. A screenshot of a "glass" pane came
  // back #000000 — not the plate, not the image, dead black — because
  // .xterm-viewport paints over .pane's background.
  it("neutralises xterm's opaque viewport plate", () => {
    // Guard the premise too: if a future xterm drops the rule, this fails and
    // tells us the override became dead weight, instead of silently rotting.
    const vendor = readFileSync("node_modules/@xterm/xterm/css/xterm.css", "utf8");
    expect(vendor).toMatch(/\.xterm\s+\.xterm-viewport\s*\{[^}]*background-color:\s*#000/);
    // The winning selector must carry the extra `.xterm`. Without it the two
    // rules tie at (0,2,0) and xterm.css takes it on source order — it is
    // injected by terminal.ts's JS import, after index.html's <link>. That tie
    // is exactly how the fix shipped once and changed nothing on screen.
    expect(rule(".term-host .xterm .xterm-viewport")).toMatch(/background-color:\s*transparent/);
  });
});
