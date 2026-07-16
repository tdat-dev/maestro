import { describe, it, expect } from "vitest";
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
