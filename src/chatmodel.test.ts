import { describe, expect, it } from "vitest";
import { createChat, describeTool, lineDiff, turnsOf, type StepItem } from "./chatmodel";

const T = "2026-09-24T10:00:00.000Z";
const line = (o: object) => JSON.stringify({ timestamp: T, ...o });
const human = (content: unknown) => line({ type: "user", origin: { kind: "human" }, message: { role: "user", content } });
const assistant = (content: unknown[]) => line({ type: "assistant", message: { role: "assistant", content } });
const result = (tool_use_id: string, content: unknown, extra?: object, is_error = false) =>
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id, content, is_error }] }, ...(extra ? { toolUseResult: extra } : {}) });

describe("chat model", () => {
  it("reads a turn: what you asked, the steps with their results, the reply", () => {
    const chat = createChat();
    chat.feed([
      human("fix the login redirect"),
      assistant([{ type: "thinking", thinking: "" }]),
      assistant([{ type: "text", text: "Looking at the auth code." }]),
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "D:\\app\\src\\auth.ts" } }]),
      result("t1", "export function login() {}"),
      assistant([{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test", description: "Run the tests" } }]),
      result("t2", "ignored", { stdout: "12 passed", stderr: "" }),
      assistant([{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: "D:\\app\\src\\auth.ts", old_string: "a\nb\nc", new_string: "a\nB\nc\nd" } }]),
      assistant([{ type: "text", text: "Fixed." }]),
      "",
    ].join("\n"));
    const kinds = chat.items.map((i) => i.kind);
    expect(kinds).toEqual(["user", "text", "step", "step", "step", "text"]);
    const [read, ran, edit] = chat.items.filter((i): i is StepItem => i.kind === "step");
    expect([read.verb, read.target, read.done, read.output]).toEqual(["Read", "auth.ts", true, "export function login() {}"]);
    expect([ran.verb, ran.target, ran.full, ran.output]).toEqual(["Ran", "Run the tests", "npm test", "12 passed"]);
    expect([edit.verb, edit.added, edit.removed, edit.done]).toEqual(["Edited", 2, 1, false]);
  });

  it("keeps out what you didn't type: reminders, hook text, helper-agent steps, meta lines", () => {
    const chat = createChat();
    chat.feed([
      human("<system-reminder>ctx</system-reminder>hello"),
      line({ type: "user", origin: { kind: "task-notification" }, message: { content: "done" } }),
      line({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "skill body" }] } }),
      line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "inner" }] } }),
      human("<command-name>/compact</command-name>\n<command-args></command-args>"),
      human("<local-command-stdout>Compacted</local-command-stdout>"),
      human("[Request interrupted by user]"),
      human([{ type: "text", text: "look" }, { type: "image", source: {} }]),
      line({ type: "system", subtype: "compact_boundary" }),
      "{not json",
    ].join("\n"));
    expect(chat.items.map((i) => (i.kind === "step" ? "step" : `${i.kind}:${"text" in i ? i.text : ""}`))).toEqual([
      "user:hello", "note:/compact", "note:You stopped the agent", "user:look", "note:Conversation compacted",
    ]);
    expect(chat.items[3]).toMatchObject({ kind: "user", images: 1 });
  });

  it("marks failed steps and fills results that arrive in a later chunk", () => {
    const chat = createChat();
    chat.feed(assistant([{ type: "tool_use", id: "x", name: "Bash", input: { command: "exit 1" } }]));
    expect((chat.items[0] as StepItem).done).toBe(false);
    chat.feed(result("x", [{ type: "text", text: "boom" }], undefined, true));
    expect(chat.items[0]).toMatchObject({ done: true, error: true, output: "boom" });
  });

  it("names tools the way a person would", () => {
    expect(describeTool("Grep", { pattern: "TODO" })).toMatchObject({ verb: "Searched for", target: "TODO" });
    expect(describeTool("WebFetch", { url: "https://docs.rs/x" })).toMatchObject({ verb: "Read", target: "docs.rs" });
    expect(describeTool("mcp__maestro__card_done", {})).toMatchObject({ verb: "Used", target: "maestro · card done" });
    expect(describeTool("TodoWrite", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] }))
      .toMatchObject({ target: "1 of 2 done", todos: [{ text: "a", state: "completed" }, { text: "b", state: "in_progress" }] });
    expect(describeTool("Write", { file_path: "/x/new.ts", content: "1\n2\n3" })).toMatchObject({ verb: "Wrote", target: "new.ts", added: 3 });
  });

  it("diffs by lines, keeping what did not change", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { sign: " ", text: "a" }, { sign: "-", text: "b" }, { sign: "+", text: "x" }, { sign: " ", text: "c" },
    ]);
  });
});

describe("chat meta", () => {
  const at = (sec: number) => new Date(Date.UTC(2026, 8, 24, 10, 0, sec)).toISOString();
  const row = (o: object) => JSON.stringify(o);
  it("knows the model, the context size, what it wrote, the files it changed and the plan", () => {
    const chat = createChat();
    const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 };
    chat.feed([
      row({ type: "user", timestamp: at(0), origin: { kind: "human" }, message: { content: "go" } }),
      // one reply written as two lines sharing its id and usage: counted once
      row({ type: "assistant", timestamp: at(2), message: { id: "m1", model: "claude-opus-5-5", usage, content: [{ type: "text", text: "ok" }] } }),
      row({ type: "assistant", timestamp: at(3), message: { id: "m1", model: "claude-opus-5-5", usage, content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "D:/a/x.ts", old_string: "a", new_string: "b\nc" } }] } }),
      row({ type: "assistant", timestamp: at(9), message: { id: "m2", model: "claude-opus-5-5", usage: { ...usage, output_tokens: 30 }, content: [{ type: "tool_use", id: "e2", name: "Edit", input: { file_path: "D:/a/x.ts", old_string: "q", new_string: "r" } }, { type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [{ content: "one", status: "completed" }] } }] } }),
    ].join("\n"));
    expect(chat.meta.model).toBe("claude-opus-5-5");
    expect(chat.meta.context).toBe(1210);
    expect(chat.meta.output).toBe(80);
    expect(chat.meta.started).toBe(Date.parse(at(0)));
    expect(chat.meta.files).toEqual([{ path: "D:/a/x.ts", name: "x.ts", added: 3, removed: 2 }]);
    expect(chat.meta.todos).toEqual([{ text: "one", state: "completed" }]);
  });

  it("splits the conversation into turns, each timed from your message to its last step", () => {
    const chat = createChat();
    chat.feed([
      row({ type: "user", timestamp: at(0), origin: { kind: "human" }, message: { content: "a" } }),
      row({ type: "assistant", timestamp: at(12), message: { content: [{ type: "text", text: "done a" }] } }),
      row({ type: "user", timestamp: at(20), origin: { kind: "human" }, message: { content: "b" } }),
      row({ type: "assistant", timestamp: at(21), message: { content: [{ type: "text", text: "done b" }] } }),
    ].join("\n"));
    const turns = turnsOf(chat.items);
    expect(turns.map((t) => [t.start, t.end, t.took])).toEqual([[0, 1, 12000], [2, 3, 1000]]);
  });
});
