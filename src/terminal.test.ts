import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mountTerminal, decodeOsc52 } from "./terminal";

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

  it("fades only the padding strip, not whole rows of text", () => {
    // A percentage stop scales with the pane: 11% of a 399px host erased ~2
    // rows of output at the top. An absolute stop can only ever cover the inset.
    const host = rule(".term-host");
    expect(host).toMatch(/mask-image:/);
    expect(host).not.toMatch(/mask-image:[^;]*\d+%/);
  });
});
