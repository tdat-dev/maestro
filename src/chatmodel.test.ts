import { describe, expect, it } from "vitest";
import { createChat, describeTool, lineDiff, type StepItem } from "./chatmodel";

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
