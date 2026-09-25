import { describe, expect, it } from "vitest";
import { createOpencodeChat, describeOpencodeTool, unifiedDiff } from "./opencodemodel";
import type { StepItem } from "./chatmodel";

// Rows as opencode_transcript hands them over: one per message or part.
const msg = (id: string, created: number, data: object) => JSON.stringify({ kind: "message", id, messageId: id, created, updated: created, data });
const part = (id: string, messageId: string, created: number, data: object) => JSON.stringify({ kind: "part", id, messageId, created, updated: created, data });
const tool = (id: string, messageId: string, created: number, name: string, state: object) => part(id, messageId, created, { type: "tool", tool: name, callID: `c_${id}`, state });

describe("opencode chat", () => {
  it("reads a turn: your message, the reply's steps with their results, its text", () => {
    const chat = createOpencodeChat();
    chat.feed([
      msg("msg_001", 1000, { role: "user", agent: "build", model: { providerID: "p", modelID: "m", variant: "high" }, time: { created: 1000 } }),
      part("prt_001", "msg_001", 1001, { type: "text", text: "fix the redirect" }),
      part("prt_002", "msg_001", 1001, { type: "text", text: "<system context>", synthetic: true }),
      msg("msg_002", 1002, { role: "assistant", modelID: "deepseek-v4", agent: "build", tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 0 } }, time: { created: 1002 } }),
      part("prt_003", "msg_002", 1003, { type: "step-start" }),
      part("prt_004", "msg_002", 1003, { type: "reasoning", text: "thinking" }),
      tool("prt_005", "msg_002", 1004, "bash", { status: "completed", input: { command: "npm test", description: "Run the tests" }, output: "12 passed", metadata: { exit: 0 } }),
      part("prt_006", "msg_002", 1005, { type: "text", text: "Fixed." }),
    ].join("\n"));
    expect(chat.items.map((i) => i.kind)).toEqual(["user", "step", "text"]);
    expect(chat.items[0]).toMatchObject({ kind: "user", text: "fix the redirect" });
    expect(chat.items[1]).toMatchObject({ verb: "Ran", target: "Run the tests", full: "npm test", output: "12 passed", done: true });
    expect(chat.meta).toMatchObject({ model: "deepseek-v4", effort: "high", permission: "build", context: 110, output: 7, turn: 1, started: 1000 });
  });

  it("updates a tool step in place as it runs, and waits for a part's message before drawing it", () => {
    const chat = createOpencodeChat();
    // a part can come in before its message row
    chat.feed(tool("prt_010", "msg_009", 2001, "bash", { status: "running", input: { command: "npm run build" } }));
    expect(chat.items).toEqual([]);
    chat.feed(msg("msg_009", 2000, { role: "assistant", modelID: "m", time: { created: 2000 } }));
    expect(chat.items).toHaveLength(1);
    expect((chat.items[0] as StepItem).done).toBe(false);
    chat.feed(tool("prt_010", "msg_009", 2001, "bash", { status: "error", input: { command: "npm run build" }, error: "exit 1" }));
    expect(chat.items).toHaveLength(1);
    expect(chat.items[0]).toMatchObject({ done: true, error: true, output: "exit 1" });
  });

  it("keeps items in time order whatever order the rows come in", () => {
    const chat = createOpencodeChat();
    chat.feed([
      msg("msg_020", 3000, { role: "assistant", time: { created: 3000 } }),
      part("prt_022", "msg_020", 3002, { type: "text", text: "second" }),
      part("prt_021", "msg_020", 3001, { type: "text", text: "first" }),
    ].join("\n"));
    expect(chat.items.map((i) => ("text" in i ? i.text : ""))).toEqual(["first", "second"]);
  });

  it("tells new files from edited ones, with the edit's own diff and counts", () => {
    const chat = createOpencodeChat();
    const patch = "Index: D:\\a\\x.ts\n===\n--- D:\\a\\x.ts\n+++ D:\\a\\x.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n";
    chat.feed([
      msg("msg_030", 4000, { role: "user", time: { created: 4000 } }),
      part("prt_030", "msg_030", 4000, { type: "text", text: "go" }),
      msg("msg_031", 4001, { role: "assistant", time: { created: 4001 } }),
      tool("prt_031", "msg_031", 4002, "write", { status: "completed", input: { filePath: "D:\\a\\new.ts", content: "a\nb" }, metadata: { exists: false, filepath: "D:\\a\\new.ts" } }),
      tool("prt_032", "msg_031", 4003, "edit", { status: "completed", input: { filePath: "D:\\a\\x.ts", oldString: "old", newString: "new" }, metadata: { filediff: { file: "D:\\a\\x.ts", patch, additions: 1, deletions: 1 } } }),
      tool("prt_033", "msg_031", 4004, "write", { status: "completed", input: { filePath: "D:\\a\\x.ts", content: "z" }, metadata: { exists: true } }),
    ].join("\n"));
    // fed again (a later read hands the same rows back): not counted twice
    chat.feed(tool("prt_032", "msg_031", 4003, "edit", { status: "completed", input: { filePath: "D:\\a\\x.ts", oldString: "old", newString: "new" }, metadata: { filediff: { patch, additions: 1, deletions: 1 } } }));
    expect(chat.meta.files.map((f) => [f.name, f.isNew, f.added, f.removed, f.steps.length])).toEqual([
      ["x.ts", false, 2, 1, 2],
      ["new.ts", true, 2, 0, 1],
    ]);
    const edit = chat.items.find((i) => i.id === "prt_032") as StepItem;
    expect(edit.diff).toEqual([{ sign: " ", text: "keep" }, { sign: "-", text: "old" }, { sign: "+", text: "new" }]);
  });

  it("shows pictures you pasted, the plan, errors and a compaction", () => {
    const chat = createOpencodeChat();
    chat.feed([
      msg("msg_040", 5000, { role: "user", time: { created: 5000 } }),
      part("prt_040", "msg_040", 5000, { type: "text", text: "look" }),
      part("prt_041", "msg_040", 5000, { type: "file", mime: "image/png", filename: "clipboard", url: "data:image/png;base64,iVBORw0KGgo=" }),
      msg("msg_041", 5001, { role: "assistant", time: { created: 5001 }, error: { name: "APIError", data: { message: "Insufficient balance" } } }),
      tool("prt_042", "msg_041", 5002, "todowrite", { status: "completed", input: { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] } }),
      part("prt_043", "msg_041", 5003, { type: "compaction", auto: true }),
    ].join("\n"));
    expect(chat.items[0]).toMatchObject({ kind: "user", text: "look", images: 1, pics: [{ media: "image/png", data: "iVBORw0KGgo=" }] });
    expect(chat.meta.todos).toEqual([{ text: "a", state: "completed" }, { text: "b", state: "in_progress" }]);
    expect(chat.items.map((i) => (i.kind === "note" ? i.text : i.kind))).toEqual(["user", "step", "Conversation compacted", "Error: Insufficient balance"]);
  });

  it("names opencode's tools the way a person would", () => {
    expect(describeOpencodeTool("read", { filePath: "D:/a/shot.png" })).toMatchObject({ verb: "Looked at", target: "shot.png" });
    expect(describeOpencodeTool("grep", { pattern: "TODO" })).toMatchObject({ verb: "Searched for", target: "TODO" });
    expect(describeOpencodeTool("webfetch", { url: "https://docs.rs/x" })).toMatchObject({ verb: "Read", target: "docs.rs" });
    expect(describeOpencodeTool("task", { description: "Write the tests" })).toMatchObject({ verb: "Asked a helper agent to", target: "Write the tests" });
    expect(describeOpencodeTool("apply_patch", { patchText: "*** Begin Patch\n*** Add File: D:/a/n.ts\n+x\n*** Update File: D:/a/o.ts\n*** End Patch" })).toMatchObject({ verb: "Edited", target: "2 files" });
    expect(describeOpencodeTool("mcp_thing", {})).toMatchObject({ verb: "Used", target: "mcp thing" });
  });

  it("reads a unified diff without its headers", () => {
    expect(unifiedDiff("--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n c\n")).toEqual([
      { sign: "-", text: "a" }, { sign: "+", text: "b" }, { sign: " ", text: "⋯" }, { sign: " ", text: "c" },
    ]);
  });
});
