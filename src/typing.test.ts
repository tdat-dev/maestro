import { describe, it, expect } from "vitest";
import {
  chunkText,
  typeInto,
  serialize,
  composerText,
  stillHolding,
  TYPE_CHUNK,
  PASTE_START,
  PASTE_END,
} from "./typing";

const noSleep = async (): Promise<void> => {};

/** A Claude Code screen with `box` sitting in the composer. */
const screenWith = (box: string): string =>
  [
    "● Reading the plan…",
    "",
    "────────────────────────────────────────",
    `> ${box}`,
    "────────────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");

describe("chunkText", () => {
  it("keeps a short message in one piece", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
  });

  it("splits a long message into chunks of the given size", () => {
    const parts = chunkText("x".repeat(250), 100);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(parts.join("")).toBe("x".repeat(250));
  });

  it("counts code points, so a surrogate pair is never cut in half", () => {
    const parts = chunkText("🙂🙂🙂🙂", 2);
    expect(parts).toEqual(["🙂🙂", "🙂🙂"]);
  });

  it("survives an empty message", () => {
    expect(chunkText("")).toEqual([]);
  });
});

describe("typeInto", () => {
  it("sends Enter as its own write, after the body", async () => {
    const sent: string[] = [];
    await typeInto(async (d) => void sent.push(d), "do the thing carefully", true, { sleep: noSleep });
    expect(sent).toEqual(["do the thing carefully", "\r"]);
  });

  it("omits Enter when not submitting", async () => {
    const sent: string[] = [];
    await typeInto(async (d) => void sent.push(d), "just paste this", false, { sleep: noSleep });
    expect(sent).toEqual(["just paste this"]);
  });

  it("chunks a long body and still ends with a lone CR", async () => {
    const body = "a".repeat(TYPE_CHUNK * 2 + 5);
    const sent: string[] = [];
    await typeInto(async (d) => void sent.push(d), body, true, { sleep: noSleep });
    expect(sent).toHaveLength(4);
    expect(sent[sent.length - 1]).toBe("\r");
    expect(sent.slice(0, -1).join("")).toBe(body);
  });

  it("presses Enter again while the message is still in the composer", async () => {
    const sent: string[] = [];
    const screens = [screenWith("do the thing carefully"), screenWith("")];
    const ok = await typeInto(async (d) => void sent.push(d), "do the thing carefully", true, {
      sleep: noSleep,
      screen: () => screens.shift() ?? screenWith(""),
    });
    expect(ok).toBe(true);
    expect(sent).toEqual(["do the thing carefully", "\r", "\r"]); // one retry, then the box was clear
  });

  it("stops pressing Enter once the composer is empty", async () => {
    const sent: string[] = [];
    const ok = await typeInto(async (d) => void sent.push(d), "do the thing carefully", true, {
      sleep: noSleep,
      screen: () => screenWith(""),
    });
    expect(ok).toBe(true);
    expect(sent).toEqual(["do the thing carefully", "\r"]);
  });

  it("never submits text that is not ours — a dimmed suggestion reads the same", async () => {
    const sent: string[] = [];
    await typeInto(async (d) => void sent.push(d), "do the thing carefully", true, {
      sleep: noSleep,
      screen: () => screenWith("sửa cái portal đi"), // history suggestion, not our text
    });
    expect(sent).toEqual(["do the thing carefully", "\r"]);
  });

  it("gives up after the last retry and says so", async () => {
    const sent: string[] = [];
    const ok = await typeInto(async (d) => void sent.push(d), "do the thing carefully", true, {
      sleep: noSleep,
      screen: () => screenWith("do the thing carefully"), // never clears
      retryWaitsMs: [1, 2],
    });
    expect(ok).toBe(false);
    expect(sent.filter((s) => s === "\r")).toHaveLength(3); // first Enter + two retries
  });

  it("verifies nothing when the caller cannot show the screen", async () => {
    const sent: string[] = [];
    const ok = await typeInto(async (d) => void sent.push(d), "do the thing carefully", true, {
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(sent).toEqual(["do the thing carefully", "\r"]);
  });

  it("wraps the body in paste markers when the target asked for them", async () => {
    const sent: string[] = [];
    await typeInto(async (d) => void sent.push(d), "line one\nline two", true, {
      sleep: noSleep,
      bracketedPaste: true,
    });
    expect(sent).toEqual([PASTE_START, "line one\nline two", PASTE_END, "\r"]);
  });

  it("marks the whole body once, not every chunk", async () => {
    const sent: string[] = [];
    await typeInto(async (d) => void sent.push(d), "abcdef", true, {
      sleep: noSleep,
      chunk: 2,
      bracketedPaste: true,
    });
    expect(sent).toEqual([PASTE_START, "ab", "cd", "ef", PASTE_END, "\r"]);
  });

  it("sends no markers to a program that never asked — they would be garbage", async () => {
    const sent: string[] = [];
    await typeInto(async (d) => void sent.push(d), "npm test", true, { sleep: noSleep });
    expect(sent).toEqual(["npm test", "\r"]);
  });

  it("closes the paste block even when not submitting", async () => {
    const sent: string[] = [];
    await typeInto(async (d) => void sent.push(d), "a path/to/file ", false, {
      sleep: noSleep,
      bracketedPaste: true,
    });
    expect(sent).toEqual([PASTE_START, "a path/to/file ", PASTE_END]);
  });

  it("waits between chunks and longer before Enter", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => void waits.push(ms);
    await typeInto(async () => {}, "abcd", true, {
      sleep,
      chunk: 2,
      gapMs: 5,
      submitDelayMs: 200,
    });
    expect(waits).toEqual([5, 200]); // one gap between the two chunks, then settle
  });
});

describe("composerText", () => {
  it("reads what is in the box, ignoring the transcript above it", () => {
    expect(composerText(screenWith("viết plan đi"))).toBe("viết plan đi");
  });

  it("is empty when the box is empty", () => {
    expect(composerText(screenWith(""))).toBe("");
  });

  it("joins a wrapped message back together", () => {
    const screen = [
      "────────────────────────────────────────",
      "> first half of the message",
      "  second half of the message",
      "────────────────────────────────────────",
    ].join("\n");
    expect(composerText(screen)).toBe("first half of the message second half of the message");
  });

  it("drops the hint line the TUI prints inside the box", () => {
    const screen = [
      "────────────────────────────────────────",
      "> ",
      "  Press up to edit queued messages",
      "────────────────────────────────────────",
    ].join("\n");
    expect(composerText(screen)).toBe("");
  });

  it("has nothing to read on a screen with no composer (a plain CLI)", () => {
    expect(composerText("$ npm test\nall good\n")).toBe("");
  });

  it("reads a boxless prompt (Codex) and ignores the footer under it", () => {
    const screen = [
      "• Working (52s • esc to interrupt)",
      "",
      "› land the archive fix and report back",
      "",
      "  gpt-5.6-sol high · D:\\ByteWaker",
    ].join("\n");
    expect(composerText(screen)).toBe("land the archive fix and report back");
  });

  it("does not mistake an old transcript prompt for the boxless composer", () => {
    const screen = [
      "> a message sent ten minutes ago",
      "● and the answer to it",
      "",
      "line",
      "line",
      "line",
      "line",
      "line",
    ].join("\n");
    expect(composerText(screen)).toBe("");
  });
});

describe("stillHolding", () => {
  it("recognises our own message wrapped across lines", () => {
    const screen = [
      "────────────────────────────────────────",
      "> Director — the numbers are wrong because",
      "  the window moved",
      "────────────────────────────────────────",
    ].join("\n");
    expect(stillHolding("Director — the numbers are wrong because the window moved", screen)).toBe(
      true,
    );
  });

  it("recognises the tail of our message when the box has scrolled", () => {
    const long = "A".repeat(400) + " and finally the last sentence.";
    expect(stillHolding(long, screenWith("and finally the last sentence."))).toBe(true);
  });

  it("refuses text that is not ours", () => {
    expect(stillHolding("send this now", screenWith("explain this codebase"))).toBe(false);
  });

  it("refuses a box too short to tell apart from a suggestion", () => {
    expect(stillHolding("go ahead now", screenWith("go ahead"))).toBe(false);
  });
});

describe("serialize", () => {
  it("runs same-key work in order, never overlapping", async () => {
    const order: string[] = [];
    const job = (tag: string, ms: number) => async () => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:end`);
    };
    const a = serialize("pane-1", job("a", 20));
    const b = serialize("pane-1", job("b", 0));
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("lets different keys run concurrently", async () => {
    const order: string[] = [];
    const a = serialize("pane-1", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("a");
    });
    const b = serialize("pane-2", async () => {
      order.push("b");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["b", "a"]);
  });

  it("a failed message does not poison the next one", async () => {
    const order: string[] = [];
    const a = serialize("pane-1", async () => {
      throw new Error("pty gone");
    });
    const b = serialize("pane-1", async () => void order.push("b"));
    await expect(Promise.all([a, b])).resolves.toBeDefined();
    expect(order).toEqual(["b"]);
  });
});
