// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  chunks: [] as string[],
  asked: [] as Array<{ dir: string; sessionId: string | null; offset: number }>,
  sent: [] as Array<[string, string]>,
  keys: [] as Array<[string, string]>,
}));
vi.mock("./ipc", () => ({
  claudeTranscript: async (dir: string, sessionId: string | null, _since: number | null, offset: number) => {
    io.asked.push({ dir, sessionId, offset });
    const text = io.chunks.shift() ?? "";
    return { path: "C:/t.jsonl", text, next: offset + text.length };
  },
  sendMessage: async (id: string, text: string) => { io.sent.push([id, text]); },
  sendInput: async (id: string, data: string) => { io.keys.push([id, data]); },
}));

import { chatSupported, dropChat, hideChat, showChat } from "./chatview";
import type { Pane } from "./panetypes";

const T = "2026-09-24T10:00:00.000Z";
const j = (o: object) => JSON.stringify({ timestamp: T, ...o }) + "\n";

function pane(badge = "claude"): Pane {
  const el = document.createElement("div");
  el.className = "pane";
  el.innerHTML = `<div class="pane-bar"></div><div class="term-host"></div>`;
  document.body.appendChild(el);
  return {
    id: "p1", el, color: "#f2b27a", running: true, spawnedAt: 1000,
    spec: { name: "Ana", badge, program: "claude", args: [], cwd: "D:/app", worktree: "D:/wt/p1", color: "", mono: "", sessionId: "11111111-2222-3333-4444-555555555555" },
    term: { focus: () => {} },
  } as unknown as Pane;
}

const flush = async () => { for (let k = 0; k < 6; k++) await new Promise((r) => setTimeout(r, 0)); };

describe("chat view", () => {
  beforeEach(() => { io.chunks = []; io.asked = []; io.sent = []; io.keys = []; });
  afterEach(() => { dropChat("p1"); document.body.innerHTML = ""; });

  it("is for Claude Code agents", () => {
    expect(chatSupported(pane())).toBe(true);
    expect(chatSupported(pane("codex"))).toBe(false);
  });

  it("reads the agent's own transcript in its worktree and draws the conversation", async () => {
    io.chunks = [
      j({ type: "user", origin: { kind: "human" }, message: { content: "fix the redirect" } }) +
      j({ type: "assistant", message: { content: [{ type: "text", text: "On it. **Done** soon." }] } }) +
      j({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }) +
      j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
    ];
    const p = pane();
    showChat(p, { name: "Ana", state: "working" });
    await flush();
    expect(io.asked[0]).toEqual({ dir: "D:/wt/p1", sessionId: "11111111-2222-3333-4444-555555555555", offset: 0 });
    expect(p.el.classList.contains("chat-on")).toBe(true);
    expect(p.el.querySelector(".cv-bubble")!.textContent).toBe("fix the redirect");
    expect(p.el.querySelector(".cv-a strong")!.textContent).toBe("Done");
    expect(p.el.querySelector(".cv-verb")!.textContent).toBe("Ran");
    expect((p.el.querySelector(".cv-working") as HTMLElement).hidden).toBe(false);
    // open a step to see its output
    (p.el.querySelector(".cv-sh") as HTMLButtonElement).click();
    expect(p.el.querySelector(".cv-out")!.textContent).toBe("ok");
  });

  it("sends what you type, stops on Esc or Stop, and gives way to the terminal", async () => {
    const p = pane();
    showChat(p, { name: "Ana", state: "working" });
    await flush();
    const input = p.el.querySelector("textarea")!;
    input.value = "  also add a test  ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(io.sent).toEqual([["p1", "also add a test"]]);
    expect(input.value).toBe("");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    (p.el.querySelector("[data-stop]") as HTMLButtonElement).click();
    expect(io.keys).toEqual([["p1", "\x1b"], ["p1", "\x1b"]]);
    hideChat(p);
    expect(p.el.classList.contains("chat-on")).toBe(false);
  });

  it("hides the composer while an answer card is up", async () => {
    const p = pane();
    showChat(p, { name: "Ana", state: "needs" });
    await flush();
    expect(p.el.querySelector(".cv")!.classList.contains("asking")).toBe(true);
  });
});
