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

  it("shows what you typed while the agent was working (a queued message), once", () => {
    const queued = (prompt: unknown, source_uuid: string, origin = "human") =>
      line({ type: "attachment", attachment: { type: "queued_command", prompt, source_uuid, commandMode: "prompt", origin: { kind: origin }, humanTurn: origin === "human" } });
    const pic = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    const chat = createChat();
    chat.feed([
      human("start"),
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 9" } }]),
      queued("don't take the mouse", "q1"),
      queued([{ type: "text", text: "why so small?" }, pic], "q2"),
      queued("<task-notification>done</task-notification>", "q3", "task-notification"),
      result("t1", "ok"),
      // the same message coming back as a plain user line is not shown twice
      line({ type: "user", uuid: "q1", origin: { kind: "human" }, message: { role: "user", content: "don't take the mouse" } }),
    ].join("\n"));
    const users = chat.items.filter((i) => i.kind === "user");
    expect(users.map((u) => ("text" in u ? u.text : ""))).toEqual(["start", "don't take the mouse", "why so small?"]);
    expect(users[2]).toMatchObject({ images: 1, pics: [{ media: "image/png" }] });
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
    expect(describeTool("Monitor", { command: "tail -f log", description: "errors in deploy.log" })).toMatchObject({ verb: "Watched", target: "errors in deploy.log" });
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
    expect(chat.meta.files).toMatchObject([{ path: "D:/a/x.ts", name: "x.ts", added: 3, removed: 2, isNew: false, turn: 1 }]);
    expect(chat.meta.todos).toEqual([{ text: "one", state: "completed" }]);
  });

  it("tells new files from edited ones, newest change first, with the reply that last touched each", () => {
    const chat = createChat();
    const tool = (id: string, name: string, input: object, sec: number) => row({ type: "assistant", timestamp: at(sec), message: { content: [{ type: "tool_use", id, name, input }] } });
    const res = (id: string, extra: object, sec: number) => row({ type: "user", timestamp: at(sec), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult: extra });
    chat.feed([
      row({ type: "user", timestamp: at(0), origin: { kind: "human" }, message: { content: "one" } }),
      tool("w1", "Write", { file_path: "D:/a/new.ts", content: "x\ny" }, 1),
      res("w1", { type: "create", filePath: "D:/a/new.ts" }, 2),
      tool("e1", "Edit", { file_path: "D:/a/old.ts", old_string: "a", new_string: "b" }, 3),
      res("e1", { type: "update", filePath: "D:/a/old.ts" }, 4),
      row({ type: "user", timestamp: at(10), origin: { kind: "human" }, message: { content: "two" } }),
      tool("e2", "Edit", { file_path: "D:\\a\\new.ts", old_string: "x", new_string: "z" }, 11),
    ].join("\n"));
    expect(chat.meta.turn).toBe(2);
    expect(chat.meta.files.map((f) => [f.name, f.isNew, f.turn, f.steps.length])).toEqual([["new.ts", true, 2, 2], ["old.ts", false, 1, 1]]);
  });

  it("keeps the effort, the permission mode and the commands left running in the background", () => {
    const chat = createChat();
    chat.feed([
      row({ type: "user", timestamp: at(0), origin: { kind: "human" }, permissionMode: "acceptEdits", message: { content: "go" } }),
      row({ type: "assistant", timestamp: at(1), effort: "high", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm run dev", description: "Start the dev server", run_in_background: true } }] } }),
      row({ type: "user", timestamp: at(2), message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "started" }] }, toolUseResult: { stdout: "", backgroundTaskId: "bt1" } }),
      row({ type: "assistant", timestamp: at(3), effort: "high", message: { content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "npm run build", run_in_background: true } }] } }),
      row({ type: "user", timestamp: at(4), message: { content: [{ type: "tool_result", tool_use_id: "b2", content: "started" }] }, toolUseResult: { stdout: "", backgroundTaskId: "bt2" } }),
      row({ type: "attachment", timestamp: at(5), attachment: { type: "task_status", taskId: "bt2", description: "Build", status: "running", outputFilePath: "C:/t/bt2.output" } }),
      row({ type: "user", timestamp: at(6), origin: { kind: "task-notification" }, message: { content: "<task-notification>\n<task-id>bt2</task-id>\n<status>failed</status>\n<output-file>C:/t/bt2.output</output-file>\n</task-notification>" } }),
      row({ type: "user", timestamp: at(7), origin: { kind: "human" }, permissionMode: "plan", message: { content: "next" } }),
    ].join("\n"));
    expect(chat.meta.effort).toBe("high");
    expect(chat.meta.permission).toBe("plan");
    expect(chat.meta.tasks.map((t) => [t.id, t.label, t.state, t.output ?? ""])).toEqual([
      ["bt1", "Start the dev server", "running", ""],
      ["bt2", "Build", "failed", "C:/t/bt2.output"],
    ]);
    // the notice is not something you said
    expect(chat.items.filter((i) => i.kind === "user").map((u) => ("text" in u ? u.text : ""))).toEqual(["go", "next"]);
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

describe("switching the model", () => {
  const row = (content: string) => JSON.stringify({ type: "user", timestamp: "2026-09-24T10:00:00.000Z", origin: { kind: "human" }, message: { content } });
  it("takes the model from /model's own answer, before any reply", () => {
    const chat = createChat();
    chat.feed([
      JSON.stringify({ type: "assistant", timestamp: "2026-09-24T09:59:00.000Z", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }] } }),
      row("<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>"),
      row("<local-command-stdout>Set model to `Haiku 4.5` and saved as your default for new sessions</local-command-stdout>"),
    ].join("\n"));
    expect(chat.meta.model).toBe("Haiku 4.5");
    // the switch reads as one line, not the raw command
    expect(chat.items.filter((i) => i.kind === "note").map((i) => ("text" in i ? i.text : ""))).toEqual(["Switched to Haiku 4.5"]);
    // and the next reply, with the model's id, is the source again
    chat.feed(JSON.stringify({ type: "assistant", timestamp: "2026-09-24T10:01:00.000Z", message: { id: "m2", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "ok" }] } }));
    expect(chat.meta.model).toBe("claude-haiku-4-5-20251001");
  });

  it("keeps the model's plain name when /model reports a long one", () => {
    const chat = createChat();
    chat.feed(row("<local-command-stdout>Set model to `Opus 5.5 (1M context) (default)` and saved as your default for new sessions</local-command-stdout>"));
    expect(chat.meta.model).toBe("Opus 5.5 (1M context)");
  });

  it("keeps what a step saw: a screenshot's picture, not the word [image]", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const chat = createChat();
    chat.feed([
      assistant([{ type: "tool_use", id: "s1", name: "mcp__claude-in-chrome__computer", input: { action: "screenshot", tabId: 1 } }]),
      result("s1", [{ type: "text", text: "Screenshot of tab 1" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }]),
      assistant([{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "D:\\shots\\home.png" } }]),
      result("r1", [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQSkZJRg==" } }]),
      // a format that could carry script is not kept
      assistant([{ type: "tool_use", id: "r2", name: "Read", input: { file_path: "D:\\a.svg" } }]),
      result("r2", [{ type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } }]),
      "",
    ].join("\n"));
    const [shot, read, svg] = chat.items.filter((i): i is StepItem => i.kind === "step");
    expect([shot.verb, shot.target, shot.output]).toEqual(["Took a screenshot", "claude in chrome", "Screenshot of tab 1"]);
    expect(shot.images).toEqual([{ media: "image/png", data: png }]);
    expect([read.verb, read.target, read.output, read.images?.length]).toEqual(["Looked at", "home.png", "", 1]);
    expect(svg.images).toBeUndefined();
  });

  it("keeps the pictures you pasted with a message, and only the last few of a burst", () => {
    const chat = createChat();
    const pic = (n: number) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: `AAAA${n}` } });
    chat.feed(human([{ type: "text", text: "this looks off" }, pic(1)]) + "\n");
    const you = chat.items[0];
    expect(you.kind === "user" && [you.text, you.images, you.pics?.length]).toEqual(["this looks off", 1, 1]);
    chat.feed(assistant([{ type: "tool_use", id: "b", name: "mcp__playwright__browser_take_screenshot", input: {} }]) + "\n" +
      result("b", Array.from({ length: 12 }, (_, k) => pic(k))) + "\n");
    const burst = chat.items.find((i): i is StepItem => i.kind === "step")!;
    expect(burst.verb).toBe("Took a screenshot");
    expect(burst.images!.map((p) => p.data)).toEqual(Array.from({ length: 8 }, (_, k) => `AAAA${k + 4}`));
  });
});
