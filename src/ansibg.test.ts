import { describe, it, expect } from "vitest";
import { rewriteSgr, isPlateColor, xterm256, createBgFilter } from "./ansibg";

const enc = new TextEncoder();
const dec = new TextDecoder();
const run = (filter: (c: Uint8Array) => Uint8Array, s: string) => dec.decode(filter(enc.encode(s)));

describe("isPlateColor", () => {
  it("drops flat charcoal but keeps a dark diff tint", () => {
    expect(isPlateColor(0x1e, 0x1e, 0x1e)).toBe(true); // opencode-ish plate
    expect(isPlateColor(0x0a, 0x0a, 0x0a)).toBe(true);
    expect(isPlateColor(0x12, 0x26, 0x1a)).toBe(false); // diff green: has chroma
    expect(isPlateColor(0x2d, 0x12, 0x12)).toBe(false); // diff red
  });
  it("keeps light neutrals — a grey surface is a real element", () => {
    expect(isPlateColor(0x99, 0x99, 0x99)).toBe(false);
  });
});

describe("xterm256", () => {
  it("maps the cube and the grey ramp", () => {
    expect(xterm256(0)).toEqual([0, 0, 0]);
    expect(xterm256(16)).toEqual([0, 0, 0]);
    expect(xterm256(232)).toEqual([8, 8, 8]);
    expect(xterm256(255)).toEqual([238, 238, 238]);
    expect(xterm256(46)).toEqual([0, 255, 0]);
  });
});

describe("rewriteSgr", () => {
  it("drops an indexed black background", () => {
    expect(rewriteSgr("40")).toBe("49");
    expect(rewriteSgr("100")).toBe("49"); // bright black
  });
  it("keeps a coloured background — it carries meaning", () => {
    expect(rewriteSgr("41")).toBe("41");
    expect(rewriteSgr("42")).toBe("42");
    expect(rewriteSgr("107")).toBe("107"); // bright white bg
  });
  it("never touches foreground parameters", () => {
    expect(rewriteSgr("30")).toBe("30");
    expect(rewriteSgr("38;5;235")).toBe("38;5;235");
    expect(rewriteSgr("1;30;4")).toBe("1;30;4");
  });
  it("drops the dark half of the 256 grey ramp, keeps the light half", () => {
    expect(rewriteSgr("48;5;235")).toBe("49");
    expect(rewriteSgr("48;5;232")).toBe("49");
    expect(rewriteSgr("48;5;250")).toBe("48;5;250");
  });
  it("handles truecolor backgrounds by chroma, not just darkness", () => {
    expect(rewriteSgr("48;2;30;30;30")).toBe("49");
    expect(rewriteSgr("48;2;18;38;26")).toBe("48;2;18;38;26");
  });
  it("edits one parameter inside a longer list and leaves the rest", () => {
    expect(rewriteSgr("1;38;5;7;48;5;236;4")).toBe("1;38;5;7;49;4");
    expect(rewriteSgr("30;48;5;16;1")).toBe("30;49;1");
  });
  it("understands the colon sub-parameter form", () => {
    expect(rewriteSgr("48:5:235")).toBe("49");
    expect(rewriteSgr("48:2::30:30:30")).toBe("49");
    expect(rewriteSgr("48:2::18:38:26")).toBe("48:2::18:38:26");
  });
  it("leaves a reset and unrelated sequences alone", () => {
    expect(rewriteSgr("")).toBe("");
    expect(rewriteSgr("0")).toBe("0");
    expect(rewriteSgr("1;22")).toBe("1;22");
  });
});

describe("createBgFilter", () => {
  it("rewrites in place and passes text through untouched", () => {
    const f = createBgFilter();
    expect(run(f, "\x1b[48;5;235mhello\x1b[0m")).toBe("\x1b[49mhello\x1b[0m");
    expect(run(f, "plain text")).toBe("plain text");
  });

  it("leaves non-SGR escapes alone", () => {
    const f = createBgFilter();
    expect(run(f, "\x1b[2J\x1b[H\x1b[10;40Hx")).toBe("\x1b[2J\x1b[H\x1b[10;40Hx");
  });

  it("carries a sequence split across chunks", () => {
    const f = createBgFilter();
    const a = run(f, "abc\x1b[48;5;");
    const b = run(f, "235mdef");
    expect(a).toBe("abc");
    expect(a + b).toBe("abc\x1b[49mdef");
  });

  it("carries a lone ESC at the chunk boundary", () => {
    const f = createBgFilter();
    const a = run(f, "x\x1b");
    const b = run(f, "[40my");
    expect(a + b).toBe("x\x1b[49my");
  });

  it("does not swallow a malformed run-on sequence", () => {
    const f = createBgFilter();
    const junk = "\x1b[" + "1;".repeat(60);
    expect(run(f, junk)).toBe(junk);
  });

  it("survives multi-byte utf-8 next to a sequence", () => {
    const f = createBgFilter();
    expect(run(f, "\x1b[40mđang chạy ✓\x1b[0m")).toBe("\x1b[49mđang chạy ✓\x1b[0m");
  });

  it("keeps a diff block's colours while clearing the surrounding plate", () => {
    const f = createBgFilter();
    const line = "\x1b[48;5;236m \x1b[48;2;18;38;26m+ added\x1b[0m";
    expect(run(f, line)).toBe("\x1b[49m \x1b[48;2;18;38;26m+ added\x1b[0m");
  });
});
