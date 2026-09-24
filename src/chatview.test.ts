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

import { chatSupported, dropChat, hideChat, modelName, showChat, took, tokens, whereIn } from "./chatview";
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
    spec: { name: "Ana", badge, program: "claude", args: [], cwd: "D:/app", worktree: "D:/wt/p1", ranIn: "D:/wt/p1", color: "", mono: "", sessionId: "11111111-2222-3333-4444-555555555555" },
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

  it("offers Start again instead of a composer when the agent is stopped", async () => {
    const p = pane();
    let restarted = 0;
    (p as unknown as { restart: () => Promise<void> }).restart = async () => { restarted++; };
    showChat(p, { name: "Ana", state: "stopped" });
    await flush();
    expect(p.el.querySelector(".cv")!.classList.contains("stopped")).toBe(true);
    expect(p.el.querySelector(".cv-empty span")!.textContent).toContain("Stopped");
    (p.el.querySelector("[data-restart-agent]") as HTMLButtonElement).click();
    expect(restarted).toBe(1);
  });

  it("hides the composer while an answer card is up", async () => {
    const p = pane();
    showChat(p, { name: "Ana", state: "needs" });
    await flush();
    expect(p.el.querySelector(".cv")!.classList.contains("asking")).toBe(true);
  });

  it("fills the space: a side panel with the plan, the files and the session, and a footer per turn", async () => {
    const usage = { input_tokens: 5, cache_read_input_tokens: 44_000, cache_creation_input_tokens: 1000, output_tokens: 900 };
    io.chunks = [
      j({ type: "user", timestamp: "2026-09-24T10:00:00.000Z", origin: { kind: "human" }, message: { content: "fix it" } }) +
      j({ type: "assistant", timestamp: "2026-09-24T10:00:05.000Z", message: { id: "m1", model: "claude-opus-5-5", usage, content: [{ type: "tool_use", id: "e", name: "Edit", input: { file_path: "D:/wt/p1/src/auth.ts", old_string: "a", new_string: "b" } }] } }) +
      j({ type: "assistant", timestamp: "2026-09-24T10:00:06.000Z", message: { id: "m1", model: "claude-opus-5-5", usage, content: [{ type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [{ content: "read", status: "completed" }, { content: "fix", status: "in_progress" }] } }] } }) +
      j({ type: "assistant", timestamp: "2026-09-24T10:01:12.000Z", message: { id: "m2", model: "claude-opus-5-5", usage, content: [{ type: "text", text: "Fixed it." }] } }),
    ];
    let reviewed = 0;
    const p = pane();
    showChat(p, { name: "Ana", state: "idle", branch: "maestro/ana", onReview: () => { reviewed++; } });
    await flush();
    const side = p.el.querySelector(".cv-side")!;
    expect(side.querySelector('[aria-label="Plan"] h3')!.textContent).toContain("1 of 2");
    expect(side.querySelector(".cs-fn")!.textContent).toBe("auth.ts");
    const session = [...side.querySelectorAll(".cs-dl div")].map((d) => [d.querySelector("dt")!.textContent, d.querySelector("dd")!.textContent]);
    expect(session).toEqual(expect.arrayContaining([["Model", "Opus 5.5"], ["Branch", "maestro/ana"], ["Context", "45k tokens"]]));
    (side.querySelector(".cs-review") as HTMLButtonElement).click();
    expect(reviewed).toBe(1);
    expect(p.el.querySelector(".cv-tf span")!.textContent).toBe("Worked for 1m 12s");
    expect(p.el.querySelector(".cv-model")!.textContent).toBe("Opus 5.5");
  });

  it("offers jobs to start from in an empty conversation, and commands from the composer", async () => {
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    const first = p.el.querySelector<HTMLButtonElement>(".cv-starters button")!;
    first.click();
    expect(p.el.querySelector("textarea")!.value).toBe(first.dataset.starter);
    (p.el.querySelector("[data-cmds]") as HTMLButtonElement).click();
    const compact = [...document.querySelectorAll<HTMLButtonElement>(".cm-item")].find((b) => b.textContent!.startsWith("/compact"))!;
    compact.click();
    expect(p.el.querySelector("textarea")!.value).toBe("/compact ");
  });
});

describe("chat view words", () => {
  it("names models, sizes and durations the way people say them", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelName("gpt-5")).toBe("gpt-5");
    expect([tokens(950), tokens(1200), tokens(45_200), tokens(1_300_000)]).toEqual(["950", "1.2k", "45k", "1.3M"]);
    expect([took(4000), took(72_000), took(120_000), took(3_780_000)]).toEqual(["4s", "1m 12s", "2m", "1h 3m"]);
  });
it("places a changed file inside the agent's folder, or says it is outside", () => {
    expect(whereIn("D:\\wt\\a\\src\\auth\\login.ts", "D:\\wt\\a")).toBe("src/auth");
    expect(whereIn("D:\\wt\\a\\README.md", "D:/wt/a/")).toBe("project root");
    expect(whereIn("C:\\Temp\\notes\\x.js", "D:\\wt\\a")).toBe("outside the project · notes");
  });
});
