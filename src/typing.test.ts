import { describe, it, expect } from "vitest";
import { chunkText, typeInto, serialize, TYPE_CHUNK } from "./typing";

const noSleep = async (): Promise<void> => {};

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
    await typeInto(async (d) => void sent.push(d), "do the thing", true, { sleep: noSleep });
    expect(sent).toEqual(["do the thing", "\r"]);
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
