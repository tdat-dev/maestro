// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  chunks: [] as string[],
  asked: [] as Array<{ dir: string; sessionId: string | null; offset: number }>,
  sent: [] as Array<[string, string]>,
  keys: [] as Array<[string, string]>,
  captured: [] as Array<{ program: string; args: string[]; cwd: string | null }>,
  sessions: [] as Array<{ id: string; modified_ms: number; title: string; messages: number; cwd?: string }>,
  everywhere: [] as Array<{ id: string; modified_ms: number; title: string; messages: number; cwd: string }>,
  opened: [] as string[],
  saved: [] as Array<{ data: string; ext: string }>,
  confirms: [] as string[],
  confirmOk: true,
  screen: "",
  hold: null as Promise<void> | null,
  readFiles: [] as Array<[string, string]>,
}));
vi.mock("./confirmmodal", () => ({
  confirmModal: async (o: { title: string }) => { io.confirms.push(o.title); return { ok: io.confirmOk, dontAsk: false, value: "" }; },
}));
vi.mock("./ipc", () => ({
  claudeTranscript: async (dir: string, sessionId: string | null, _since: number | null, offset: number) => {
    io.asked.push({ dir, sessionId, offset });
    if (io.hold) await io.hold;
    const text = io.chunks.shift() ?? "";
    return { path: "C:/t.jsonl", text, next: offset + text.length };
  },
  sendMessage: async (id: string, text: string) => { io.sent.push([id, text]); },
  sendInput: async (id: string, data: string) => { io.keys.push([id, data]); },
  claudeSessions: async () => io.sessions,
  fsReadFile: async (root: string, path: string) => { io.readFiles.push([root, path]); return { content: "step 1\nerror: build failed\n", mtime: 0 }; },
  claudeSessionsEverywhere: async () => io.everywhere,
  openExternal: async (url: string) => { io.opened.push(url); },
  savePastedImage: async (data: string, ext: string) => { io.saved.push({ data, ext }); return `C:/tmp/pasted-${io.saved.length}.${ext}`; },
  // Claude Code's own list, as its init event gives it.
  runCapture: async (program: string, args: string[], cwd: string | null) => {
    io.captured.push({ program, args, cwd });
    return JSON.stringify({ type: "system", subtype: "hook_started" }) + "\n" +
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5", slash_commands: ["compact", "review", "impeccable", "codex:rescue"], skills: ["impeccable"] }) + "\n";
  },
}));

import { ago, chatCommand, chatSupported, dropChat, grownSize, hideChat, modelAlias, modelName, showChat, took, tokens, whereIn } from "./chatview";
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
    term: { focus: () => {}, snapshot: () => io.screen },
  } as unknown as Pane;
}

const flush = async () => { for (let k = 0; k < 6; k++) await new Promise((r) => setTimeout(r, 0)); };

describe("chat view", () => {
  beforeEach(() => { io.chunks = []; io.asked = []; io.sent = []; io.keys = []; io.sessions = []; io.opened = []; io.saved = []; io.confirms = []; io.confirmOk = true; io.screen = ""; });
  afterEach(() => { dropChat("p1"); document.body.innerHTML = ""; });

  it("shows a long conversation once it has all of it, at the bottom, not slice by slice", async () => {
    // three slices, the middle one still on its way
    io.chunks = [
      j({ type: "user", origin: { kind: "human" }, message: { content: "first" } }),
      j({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } }),
      j({ type: "user", origin: { kind: "human" }, message: { content: "last" } }),
    ];
    let release!: () => void;
    io.hold = new Promise<void>((r) => { release = r; });
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    // still reading: nothing half-drawn
    expect(p.el.querySelector(".cv-thread")!.textContent).toContain("Loading the conversation");
    expect(p.el.querySelector(".cv-bubble")).toBeNull();
    io.hold = null;
    release();
    await flush();
    await flush();
    expect([...p.el.querySelectorAll(".cv-bubble")].map((b) => b.textContent)).toEqual(["first", "last"]);
    expect(io.asked.length).toBeGreaterThanOrEqual(4); // read to the end in one go
  });

  it("shows a question the agent asks you as a card: waiting, then what you picked", async () => {
    const ask = { questions: [{ question: "Which layout?", header: "Layout", options: [{ label: "Chat left", description: "Work panel on the right" }, { label: "Chat wide" }] }] };
    io.chunks = [
      j({ type: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: "Bash", input: { command: "ls" } }] } }) +
      j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "s1", content: "a" }] } }) +
      j({ type: "assistant", message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: ask }] } }),
    ];
    const p = pane();
    showChat(p, { name: "Ana", state: "needs" });
    await flush();
    const card = p.el.querySelector(".cv-ask")!;
    expect(card.classList.contains("waiting")).toBe(true);
    expect(card.querySelector(".cv-qt")!.textContent).toBe("Which layout?");
    expect([...card.querySelectorAll(".cv-qo li b")].map((b) => b.textContent)).toEqual(["Chat left", "Chat wide"]);
    expect(card.querySelector(".cv-qs")!.textContent).toContain("Waiting for your answer");
    // not folded in with the steps around it
    expect(card.closest(".cv-steps")).toBeNull();
    io.chunks = [j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "q1", content: 'Your questions have been answered: "Which layout?"="Chat left".' }] } })];
    await new Promise((r) => setTimeout(r, 900));
    await flush();
    const done = p.el.querySelector(".cv-ask")!;
    expect(done.classList.contains("waiting")).toBe(false);
    expect(done.querySelector(".cv-qo li.on b")!.textContent).toBe("Chat left");
  });

  it("is for the CLIs whose conversation it can read", () => {
    expect(chatSupported(pane())).toBe(true);
    expect(chatSupported(pane("codex"))).toBe(true);
    expect(chatSupported(pane("opencode"))).toBe(true);
    expect(chatSupported(pane("aider"))).toBe(false);
    expect(chatSupported(pane("shell"))).toBe(false);
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

  it("offers Resume instead of a composer when the agent is stopped", async () => {
    const p = pane();
    let restarted = 0;
    (p as unknown as { restart: () => Promise<void> }).restart = async () => { restarted++; };
    showChat(p, { name: "Ana", state: "stopped" });
    await flush();
    expect(p.el.querySelector(".cv")!.classList.contains("stopped")).toBe(true);
    expect(p.el.querySelector(".cv-empty span")!.textContent).toBe("Resume it to carry on, or start a new conversation.");
    (p.el.querySelector("[data-restart-agent]") as HTMLButtonElement).click();
    expect(restarted).toBe(1);
  });

  it("hides the composer only while an answer card is up, and never offers jobs then", async () => {
    const p = pane();
    showChat(p, { name: "Ana", state: "needs", asking: true });
    await flush();
    expect(p.el.querySelector(".cv")!.classList.contains("asking")).toBe(true);
    expect(p.el.querySelector(".cv-starters")).toBeNull();
    expect(p.el.querySelector(".cv-empty b")!.textContent).toBe("Ana is waiting on you");
    // needs you, but no card to answer on: the composer is the way to reply
    showChat(p, { name: "Ana", state: "needs" });
    expect(p.el.querySelector(".cv")!.classList.contains("asking")).toBe(false);
  });

  it("says why an agent couldn't start, and offers to try again", async () => {
    const p = pane();
    showChat(p, { name: "Ana", state: "stopped", problem: "The folder D:/gone doesn't exist anymore." });
    await flush();
    expect(p.el.querySelector(".cv-why")!.textContent).toBe("The folder D:/gone doesn't exist anymore.");
    expect(p.el.querySelector("[data-restart-agent]")!.textContent).toBe("Try again");
  });

  it("opens links from an answer in the browser, not in the app's window", async () => {
    io.chunks = [j({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "See [the docs](https://example.com/docs)." }] } })];
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    const a = p.el.querySelector<HTMLAnchorElement>(".cv-a a")!;
    expect(a.title).toBe("https://example.com/docs");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(io.opened).toEqual(["https://example.com/docs"]);
  });

  it("opens and closes a plan step as often as you like", async () => {
    io.chunks = [j({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [{ content: "read", status: "completed" }] } }] } })];
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    const head = () => p.el.querySelector<HTMLButtonElement>(".cv-step button.cv-sh")!;
    expect(head().getAttribute("aria-expanded")).toBe("true");
    head().click();
    expect(head().getAttribute("aria-expanded")).toBe("false");
    head().click();
    expect(head().getAttribute("aria-expanded")).toBe("true");
    head().click();
    expect(head().getAttribute("aria-expanded")).toBe("false");
  });

  it("draws an edit's lines without blank lines between them", async () => {
    io.chunks = [j({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "e", name: "Edit", input: { file_path: "D:/wt/p1/a.ts", old_string: "a\nb", new_string: "a\nc" } }] } })];
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    p.el.querySelector<HTMLButtonElement>(".cv-step button.cv-sh")!.click();
    const pre = p.el.querySelector(".cv-diff")!;
    expect(pre.innerHTML).not.toContain("\n");
    expect(pre.querySelectorAll("span").length).toBeGreaterThan(1);
  });

  it("shows what the agent saw: its screenshots under the step, full size on a click", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: png } };
    io.chunks = [
      j({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "s1", name: "mcp__claude-in-chrome__computer", input: { action: "screenshot" } }] } }) +
      j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "s1", content: [image, image] }] } }) +
      j({ type: "user", origin: { kind: "human" }, message: { content: [{ type: "text", text: "like this" }, image] } }),
    ];
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    const shots = [...p.el.querySelectorAll<HTMLButtonElement>(".cv-step .cv-shot")];
    expect(shots).toHaveLength(2);
    const src = shots[0].querySelector("img")!.getAttribute("src")!;
    expect(src.startsWith("blob:") || src.startsWith("data:image/png;base64,")).toBe(true);
    expect(shots[0].getAttribute("aria-label")).toBe("Screenshot 1 of 2, open full size");
    // what you pasted shows as a picture in your bubble, not as "1 image"
    expect(p.el.querySelector(".cv-bubble .cv-shot img")).not.toBeNull();
    expect(p.el.querySelector(".cv-bubble .cv-img")).toBeNull();
    shots[1].click();
    const lb = document.querySelector<HTMLElement>(".cv-lb")!;
    expect(lb.querySelector(".cv-lb-t")!.textContent).toBe("Took a screenshot claude in chrome");
    expect(lb.querySelector(".cv-lb-n")!.textContent).toBe("2 / 2");
    expect(lb.querySelector<HTMLImageElement>(".cv-lb-img")!.getAttribute("src")).toBe(shots[1].querySelector("img")!.getAttribute("src"));
    lb.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(lb.querySelector(".cv-lb-n")!.textContent).toBe("1 / 2");
    lb.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".cv-lb")).toBeNull();
    expect(io.keys).toEqual([]); // Esc closed the picture, it didn't stop the agent
  });

  it("asks before switching conversations while the agent works", async () => {
    io.sessions = [{ id: "aaaaaaaa-2222-3333-4444-555555555555", modified_ms: Date.now(), title: "Fix the login", messages: 12 }];
    const p = pane();
    const restarts: unknown[] = [];
    (p as unknown as { restart: (o?: unknown) => Promise<void> }).restart = async (o) => { restarts.push(o); };
    showChat(p, { name: "Ana", state: "working" });
    await flush();
    io.confirmOk = false;
    p.el.querySelector<HTMLButtonElement>("[data-resume]")!.click();
    await flush();
    expect(io.confirms).toEqual(["Stop Ana and switch conversations?"]);
    expect(restarts).toEqual([]);
    io.confirmOk = true;
    p.el.querySelector<HTMLButtonElement>("[data-resume]")!.click();
    await flush();
    expect(restarts).toEqual([{ session: "aaaaaaaa-2222-3333-4444-555555555555" }]);
  });

  it("fills the space: a work panel with the changes, the session and the plan in tabs, and a footer per turn", async () => {
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
    // opens on what it changed: the file, and its diff large beside the list
    expect(side.querySelector('[role=tab][aria-selected="true"]')!.textContent).toContain("Changes");
    expect(side.querySelector(".cs-fn")!.textContent).toBe("auth.ts");
    expect([...side.querySelectorAll(".cp-view .cv-diff span")].map((s) => s.textContent)).toEqual(["- a", "+ b"]);
    (side.querySelector(".cs-review") as HTMLButtonElement).click();
    expect(reviewed).toBe(1);
    (side.querySelector('[data-tab="session"]') as HTMLButtonElement).click();
    expect(side.querySelector('[aria-label="Plan"] h3')!.textContent).toContain("1 of 2");
    const session = [...side.querySelectorAll(".cs-dl div")].map((d) => [d.querySelector("dt")!.textContent, d.querySelector("dd")!.textContent]);
    expect(session).toEqual(expect.arrayContaining([["Model", "Opus 5.5"], ["Branch", "maestro/ana"], ["Context", "45k tokens"]]));
    expect(p.el.querySelector(".cv-tf span")!.textContent).toBe("Worked for 1m 12s");
    expect(p.el.querySelector(".cv-model .cv-chip-t")!.textContent).toBe("Opus 5.5");
  });

  it("offers jobs to start from in an empty conversation, and commands from the composer", async () => {
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    const first = p.el.querySelector<HTMLButtonElement>(".cv-starters button")!;
    first.click();
    expect(p.el.querySelector("textarea")!.value).toBe(first.dataset.starter);
    (p.el.querySelector("[data-cmds]") as HTMLButtonElement).click();
    await flush();
    // The list is the CLI's own, asked in the agent's folder without a model call.
    expect(io.captured[0].args).toEqual(expect.arrayContaining(["-p", "/cost", "--output-format", "stream-json"]));
    expect(io.captured[0].cwd).toBe("D:/wt/p1");
    const labels = [...document.querySelectorAll(".pal-row, [role=option]")].map((r) => r.textContent ?? "");
    expect(labels.some((l) => l.includes("/codex:rescue"))).toBe(true);
    const compact = [...document.querySelectorAll<HTMLElement>(".pal-row, [role=option]")].find((r) => r.textContent!.includes("/compact"))!;
    compact.click();
    expect(p.el.querySelector("textarea")!.value).toBe("/compact ");
  });
it("answers /resume itself: its conversations to pick from, the pick resumed here", async () => {
    io.sessions = [
      { id: "11111111-2222-3333-4444-555555555555", modified_ms: Date.now(), title: "This one", messages: 3 },
      { id: "aaaaaaaa-2222-3333-4444-555555555555", modified_ms: Date.now() - 3_600_000, title: "Fix the login", messages: 12 },
    ];
    const p = pane();
    const restarts: unknown[] = [];
    (p as unknown as { restart: (o?: unknown) => Promise<void> }).restart = async (o) => { restarts.push(o); };
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    // the side panel offers the other one
    expect(p.el.querySelector(".cs-ct")!.textContent).toBe("Fix the login");
    const input = p.el.querySelector("textarea")!;
    input.value = "/resume";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(io.sent).toEqual([]); // not typed into the hidden terminal picker
    const row = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((r) => r.textContent!.includes("Fix the login"))!;
    row.click();
    await flush();
    expect(restarts).toEqual([{ session: "aaaaaaaa-2222-3333-4444-555555555555" }]);
    input.value = "/clear";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(restarts[1]).toEqual({ fresh: true });
    expect(io.confirms).toEqual([]); // not working: nothing to ask
    io.everywhere = [];
  });

  it("offers conversations from other folders too, and carries one on in its own folder", async () => {
    io.sessions = [{ id: "11111111-2222-3333-4444-555555555555", modified_ms: Date.now(), title: "This one", messages: 3, cwd: "D:/wt/p1" }];
    io.everywhere = [
      { id: "11111111-2222-3333-4444-555555555555", modified_ms: Date.now(), title: "This one", messages: 3, cwd: "D:/wt/p1" },
      { id: "bbbbbbbb-2222-3333-4444-555555555555", modified_ms: Date.now() - 60_000, title: "Ship the APK", messages: 8, cwd: "D:\\Zoldify" },
      { id: "cccccccc-2222-3333-4444-555555555555", modified_ms: Date.now() - 90_000, title: "Back home", messages: 2, cwd: "d:\\wt\\p1\\" },
    ];
    const p = pane();
    const restarts: unknown[] = [];
    (p as unknown as { restart: (o?: unknown) => Promise<void> }).restart = async (o) => { restarts.push(o); };
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    const input = p.el.querySelector("textarea")!;
    input.value = "/resume";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    const rows = [...document.querySelectorAll<HTMLElement>("[role=option]")];
    // its own folder's conversation isn't listed twice, however the path is written
    expect(rows.filter((r) => r.textContent!.includes("This one")).length).toBe(1);
    expect(rows.some((r) => r.textContent!.includes("Back home"))).toBe(false);
    const other = rows.find((r) => r.textContent!.includes("Ship the APK"))!;
    expect(other.textContent).toContain("Zoldify");
    other.click();
    await flush();
    expect(restarts).toEqual([{ session: "bbbbbbbb-2222-3333-4444-555555555555", dir: "D:\\Zoldify" }]);
    io.everywhere = [];
  });

  it("offers Resume and New conversation when stopped", async () => {
    const p = pane();
    const restarts: unknown[] = [];
    (p as unknown as { restart: (o?: unknown) => Promise<void> }).restart = async (o) => { restarts.push(o); };
    showChat(p, { name: "Ana", state: "stopped" });
    await flush();
    (p.el.querySelector("[data-restart-agent]") as HTMLButtonElement).click();
    (p.el.querySelector("[data-new-convo]") as HTMLButtonElement).click();
    await flush();
    expect(restarts).toEqual([undefined, { fresh: true }]);
  });
  it("lets you pick any model, the one in use marked, and switches through the CLI", async () => {
    io.chunks = [
      JSON.stringify({ type: "user", timestamp: "2026-09-24T10:00:00.000Z", origin: { kind: "human" }, message: { content: "<local-command-stdout>Set model to `Haiku 4.5` and saved as your default for new sessions</local-command-stdout>" } }) + "\n",
    ];
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    (p.el.querySelector("[data-model]") as HTMLButtonElement).click();
    const rows = [...document.querySelectorAll<HTMLButtonElement>(".cm-item")];
    expect(rows.filter((b) => b.getAttribute("aria-disabled") === "true")).toEqual([]);
    const haiku = rows.find((b) => b.textContent!.startsWith("Haiku"))!;
    expect(haiku.textContent).toContain("In use");
    rows.find((b) => b.textContent!.startsWith("Opus") && !b.textContent!.startsWith("Opus Plan"))!.click();
    expect(io.sent).toEqual([["p1", "/model opus"]]);
  });

  it("empties at once for a new conversation, before it has written anything", async () => {
    io.chunks = [j({ type: "user", origin: { kind: "human" }, message: { content: "old talk" } })];
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    expect(p.el.querySelector(".cv-bubble")!.textContent).toBe("old talk");
    // /clear or New conversation: a new session id, no file for it yet
    p.spec.sessionId = "99999999-2222-3333-4444-555555555555";
    showChat(p, { name: "Ana", state: "working" });
    expect(p.el.querySelector(".cv-bubble")).toBeNull();
    await flush();
    expect(p.el.querySelector(".cv-bubble")).toBeNull();
    expect(io.asked[io.asked.length - 1].sessionId).toBe("99999999-2222-3333-4444-555555555555");
  });

});

describe("chat view words", () => {
  it("tells which alias a model is, from however Claude names it", () => {
    expect(modelAlias("Opus 5.5 (1M context)")).toBe("opus");
    expect(modelAlias("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(modelAlias("Sonnet 5")).toBe("sonnet");
    expect(modelAlias("Opus in plan mode, else Sonnet")).toBe("opusplan");
    expect(modelAlias(null)).toBeNull();
  });

  it("knows which commands the chat answers itself", () => {
    expect(chatCommand("/resume")).toEqual({ kind: "resume", query: "" });
    expect(chatCommand(" /resume login bug ")).toEqual({ kind: "resume", query: "login bug" });
    expect(chatCommand("/clear")).toEqual({ kind: "clear" });
    expect(chatCommand("/resumes")).toBeNull();
    expect(chatCommand("please /resume")).toBeNull();
    const now = Date.parse("2026-09-24T12:00:00Z");
    expect([ago(now - 20_000, now), ago(now - 5 * 60_000, now), ago(now - 3 * 3_600_000, now)]).toEqual(["just now", "5m ago", "3h ago"]);
  });

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
  it("takes a pasted picture: shows it, lets you drop it, sends it as a file with your words", async () => {
    dropChat("p1"); document.body.innerHTML = ""; io.sent = []; io.saved = [];
    if (!URL.createObjectURL) (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:x";
    if (!URL.revokeObjectURL) (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    const input = p.el.querySelector<HTMLTextAreaElement>(".cv textarea")!;
    const paste = (n: number) => {
      const e = new Event("paste", { bubbles: true, cancelable: true });
      const files = Array.from({ length: n }, (_, k) => new File([new Uint8Array([137, 80, 78, 71, k])], `s${k}.png`, { type: "image/png" }));
      Object.defineProperty(e, "clipboardData", { value: { items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })), getData: () => "" } });
      input.dispatchEvent(e);
      return e;
    };
    expect(paste(2).defaultPrevented).toBe(true);
    await flush();
    const atts = p.el.querySelector<HTMLElement>(".cv-atts")!;
    expect(atts.hidden).toBe(false);
    expect(atts.querySelectorAll(".cv-att").length).toBe(2);
    expect(io.saved.map((s) => [s.ext, s.data])).toEqual([["png", "iVBORwA="], ["png", "iVBORwE="]]);
    // a pasted picture opens full size, on the one you clicked
    atts.querySelector<HTMLElement>("[data-att-open='1']")!.click();
    const lb = document.querySelector(".cv-lb")!;
    expect(lb).not.toBeNull();
    expect(lb.querySelector(".cv-lb-img")!.getAttribute("alt")).toBe("You're sending, picture 2 of 2");
    lb.querySelector<HTMLElement>("[data-lb-close]")!.click();
    expect(document.querySelector(".cv-lb")).toBeNull();
    atts.querySelector<HTMLElement>("[data-att-x='0']")!.click();
    expect(atts.querySelectorAll(".cv-att").length).toBe(1);
    input.value = "why so small?";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(io.sent.map(([, t]) => t)).toEqual(["C:/tmp/pasted-2.png", " ", "why so small?"]);
    expect(atts.hidden).toBe(true);
    expect(input.value).toBe("");
  });

  it("a picture alone is sent by itself; text on the clipboard still pastes as text", async () => {
    dropChat("p1"); document.body.innerHTML = ""; io.sent = []; io.saved = [];
    if (!URL.createObjectURL) (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:x";
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    const input = p.el.querySelector<HTMLTextAreaElement>(".cv textarea")!;
    const plain = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(plain, "clipboardData", { value: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }], getData: () => "hi" } });
    input.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    const e = new Event("paste", { bubbles: true, cancelable: true });
    const f = new File([new Uint8Array([1])], "a.jpg", { type: "image/jpeg" });
    Object.defineProperty(e, "clipboardData", { value: { items: [{ kind: "file", type: "image/jpeg", getAsFile: () => f }], getData: () => "" } });
    input.dispatchEvent(e);
    await flush();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(io.sent.map(([, t]) => t)).toEqual(["C:/tmp/pasted-1.jpg"]);
  });

  it("grows a small picture to fill its box, never past 3×, and leaves big ones alone", () => {
    expect(grownSize(161, 100, 420, 240)).toEqual({ w: 386, h: 240 });
    expect(grownSize(40, 40, 420, 240)).toEqual({ w: 120, h: 120 });
    expect(grownSize(1280, 800, 420, 240)).toBeNull();
    expect(grownSize(410, 230, 420, 240)).toBeNull();
    expect(grownSize(0, 0, 420, 240)).toBeNull();
  });
});

describe("chat view: what the CLI offers", () => {
  beforeEach(() => { dropChat("p1"); document.body.innerHTML = ""; io.chunks = []; io.asked = []; io.sent = []; io.keys = []; io.sessions = []; io.screen = ""; });
  afterEach(() => { dropChat("p1"); document.body.innerHTML = ""; });
  const menuPick = (label: string) => {
    const item = [...document.querySelectorAll<HTMLElement>(".cm-item")].find((b) => b.textContent?.startsWith(label));
    item!.click();
  };

  it("shows the effort in use and sets another with the CLI's own /effort", async () => {
    io.chunks = [j({ type: "assistant", effort: "medium", message: { content: [{ type: "text", text: "hi" }] } })];
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    const chip = p.el.querySelector<HTMLElement>('[data-setting="effort"]')!;
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe("Effort: Medium");
    chip.click();
    expect(document.querySelector(".cm-menu")!.textContent).toContain("In use");
    menuPick("High");
    await flush();
    expect(io.sent).toEqual([["p1", "/effort high"]]);
    expect(chip.textContent).toBe("Effort: High");
  });

  it("switches the permission mode with Shift+Tab until the footer shows it", async () => {
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    const chip = p.el.querySelector<HTMLElement>('[data-setting="permission"]')!;
    expect(chip.textContent).toBe("Ask first");
    // each Shift+Tab moves the footer one mode on
    const modes = ["", "⏵⏵ accept edits on (shift+tab to cycle)", "⏸ plan mode on (shift+tab to cycle)"];
    let k = 0;
    const realKeys = io.keys;
    io.keys = new Proxy(realKeys, { get(t, prop) { if (prop === "push") return (x: [string, string]) => { k++; io.screen = modes[k % modes.length]; return t.push(x); }; return Reflect.get(t, prop); } });
    chip.click();
    menuPick("Plan");
    await new Promise((r) => setTimeout(r, 900));
    expect(realKeys).toEqual([["p1", "\x1b[Z"], ["p1", "\x1b[Z"]]);
    expect(chip.textContent).toBe("Plan");
    io.keys = realKeys;
  });

  it("lists commands left running in the background, and a stopped agent's as stopped", async () => {
    io.chunks = [
      j({ type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm run dev", description: "Start the dev server", run_in_background: true } }] } }) +
      j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "started" }] }, toolUseResult: { backgroundTaskId: "bt1" } }) +
      j({ type: "attachment", attachment: { type: "task_status", taskId: "bt2", description: "Build", status: "failed", outputFilePath: "C:/t/bt2.output" } }),
    ];
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    const rows = [...p.el.querySelectorAll(".cs-tasks li")].map((li) => [li.className, li.querySelector(".cs-tl")!.textContent, li.querySelector(".cs-ts")!.textContent]);
    expect(rows).toEqual([["running", "Start the dev server", "Running"], ["failed", "Build", "Failed"]]);
    // with nothing changed, the panel opens on what is running
    expect(p.el.querySelector('[role=tab][aria-selected="true"]')!.textContent).toBe("Background1 running");
    // picking one shows its output in the panel
    p.el.querySelector<HTMLElement>('[data-task="bt2"]')!.click();
    await flush();
    expect(io.readFiles).toEqual([["C:/t", "bt2.output"]]);
    expect(p.el.querySelector(".cp-out")!.textContent).toContain("error: build failed");
    p.running = false;
    showChat(p, { name: "Ana", state: "stopped" });
    await flush();
    expect(p.el.querySelector(".cs-tasks li")!.className).toBe("stopped");
  });

  it("splits Files changed into New and Edited, marks the latest reply's, and opens a file's diff", async () => {
    const tool = (id: string, name: string, input: object) => j({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    const res = (id: string, extra: object) => j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult: extra });
    io.chunks = [
      j({ type: "user", origin: { kind: "human" }, message: { content: "one" } }) +
      tool("e1", "Edit", { file_path: "D:/wt/p1/src/old.ts", old_string: "a", new_string: "b" }) + res("e1", { type: "update" }) +
      j({ type: "user", origin: { kind: "human" }, message: { content: "two" } }) +
      tool("w1", "Write", { file_path: "D:/wt/p1/src/new.ts", content: "hello" }) + res("w1", { type: "create" }),
    ];
    const p = pane();
    showChat(p, { name: "Ana", state: "idle" });
    await flush();
    const side = p.el.querySelector(".cv-side")!;
    expect([...side.querySelectorAll(".cs-sub")].map((h) => h.textContent)).toEqual(["New 1", "Edited 1"]);
    const names = [...side.querySelectorAll(".cs-files li")].map((li) => [li.querySelector(".cs-fn")!.textContent, li.classList.contains("now")]);
    expect(names).toEqual([["new.ts", true], ["old.ts", false]]);
    // the newest is picked first; picking another shows its diff large beside the list
    expect(side.querySelector(".cp-vh b")!.textContent).toBe("new.ts");
    side.querySelector<HTMLElement>('[data-file="D:/wt/p1/src/old.ts"]')!.click();
    expect(p.el.querySelector(".cv-side .cp-vh b")!.textContent).toBe("old.ts");
    const diff = p.el.querySelector(".cv-side .cp-view .cs-diff")!;
    expect([...diff.querySelectorAll("span")].map((s) => s.textContent)).toEqual(["- a", "+ b"]);
  });
});
