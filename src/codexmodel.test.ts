import { describe, expect, it } from "vitest";
import { createCodexChat, describeCodexTool, parsePatch, userWords } from "./codexmodel";
import type { StepItem } from "./chatmodel";

const at = (sec: number) => new Date(Date.UTC(2026, 8, 25, 10, 0, sec)).toISOString();
const row = (sec: number, type: string, payload: object) => JSON.stringify({ timestamp: at(sec), type, payload });
const item = (sec: number, payload: object) => row(sec, "response_item", payload);
const user = (sec: number, ...texts: string[]) => item(sec, { type: "message", role: "user", content: texts.map((text) => ({ type: "input_text", text })) });
const said = (sec: number, text: string) => item(sec, { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const call = (sec: number, call_id: string, name: string, args: object) => item(sec, { type: "function_call", call_id, name, arguments: JSON.stringify(args) });
const out = (sec: number, call_id: string, output: unknown) => item(sec, { type: "function_call_output", call_id, output });
const steps = (c: ReturnType<typeof createCodexChat>) => c.items.filter((i): i is StepItem => i.kind === "step");

describe("codex chat", () => {
  it("reads a turn: what you asked, its commands with their output, its reply", () => {
    const c = createCodexChat();
    c.feed([
      row(0, "session_meta", { id: "s", cwd: "D:\\app" }),
      item(0, { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>" }] }),
      user(1, "<environment_context>\n  <cwd>D:\\app</cwd>\n</environment_context>"),
      user(2, "# AGENTS.md instructions for D:\\app\n\nrules"),
      user(3, "fix the login redirect"),
      said(4, "Looking at the auth code."),
      call(5, "c1", "shell_command", { command: "npm test", workdir: "D:\\app" }),
      out(6, "c1", "Exit code: 0\nWall time: 2.1 seconds\nOutput:\n12 passed\n"),
      call(7, "c2", "exec_command", { cmd: "npm run lint" }),
      out(8, "c2", "Chunk ID: a1\nWall time: 1.0 seconds\nProcess exited with code 1\nOriginal token count: 3\nOutput:\nlint error\n"),
      said(9, "Fixed."),
    ].join("\n"));
    expect(c.items.map((i) => i.kind)).toEqual(["user", "text", "step", "step", "text"]);
    expect(c.items[0]).toMatchObject({ kind: "user", text: "fix the login redirect" });
    const [test, lint] = steps(c);
    expect([test.verb, test.target, test.output, test.error, test.done]).toEqual(["Ran", "npm test", "12 passed", false, true]);
    expect([lint.output, lint.error]).toEqual(["lint error", true]);
    expect(c.meta.turn).toBe(1);
    expect(c.meta.started).toBe(Date.parse(at(0)));
  });

  it("keeps only your words out of IDE and pasted-file preambles, with your pictures", () => {
    const w = userWords([
      { type: "input_text", text: "\n# Files mentioned by the user:\n\n## shot.png: C:/t/shot.png\n\n## My request:\nmake it blue\n" },
      { type: "input_text", text: "<image name=[Image #1] path=\"C:\\t\\shot.png\">" },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      { type: "input_text", text: "</image>" },
    ]);
    expect(w).toEqual({ text: "make it blue", pics: [{ media: "image/png", data: "iVBORw0KGgo=" }] });
    expect(userWords([{ type: "input_text", text: "# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n\n## My request for Codex:\nrename it" }]).text).toBe("rename it");
    expect(userWords([{ type: "input_text", text: "<recommended_plugins>\n- x\n</recommended_plugins>" }]).text).toBe("");
  });

  it("reads a patch per file: new, edited, deleted, with their diffs", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: D:/app/new.ts",
      "+export const a = 1;",
      "+export const b = 2;",
      "*** Update File: D:/app/old.ts",
      "@@ function x",
      " keep",
      "-gone",
      "+here",
      "@@",
      "+more",
      "*** Delete File: D:/app/dead.ts",
      "*** End Patch",
    ].join("\n");
    const files = parsePatch(patch);
    expect(files.map((f) => [f.path, f.kind, f.added, f.removed])).toEqual([
      ["D:/app/new.ts", "add", 2, 0], ["D:/app/old.ts", "update", 2, 1], ["D:/app/dead.ts", "delete", 0, 0],
    ]);
    expect(files[1].diff.map((d) => d.sign + d.text)).toEqual([" keep", "-gone", "+here", " ⋯", "+more"]);

    const c = createCodexChat();
    c.feed([
      user(0, "go"),
      item(1, { type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: patch }),
      item(2, { type: "custom_tool_call_output", call_id: "p1", output: JSON.stringify({ output: "Success. Updated the following files:\nA D:/app/new.ts\n", metadata: { exit_code: 0 } }) }),
    ].join("\n"));
    expect(steps(c).map((s) => [s.verb, s.target, s.done, s.error])).toEqual([
      ["Wrote", "new.ts", true, false], ["Edited", "old.ts", true, false], ["Deleted", "dead.ts", true, false],
    ]);
    expect(c.meta.files.map((f) => [f.name, f.isNew, !!f.deleted, f.turn])).toEqual([
      ["new.ts", true, false, 1], ["old.ts", false, false, 1], ["dead.ts", false, true, 1],
    ]);
  });

  it("knows the model, effort, approval policy and context from Codex's settings and token counts", () => {
    const c = createCodexChat();
    c.feed([
      row(0, "turn_context", { cwd: "D:\\app", approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, model: "gpt-5.4", collaboration_mode: { mode: "default", settings: { reasoning_effort: "medium" } } }),
      row(1, "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 900, output_tokens: 120 }, last_token_usage: { input_tokens: 500, cached_input_tokens: 300, output_tokens: 40 } } }),
    ].join("\n"));
    expect([c.meta.model, c.meta.effort, c.meta.permission, c.meta.context, c.meta.output]).toEqual(["gpt-5.4", "medium", "on-request", 500, 120]);
    c.feed(row(2, "event_msg", { type: "thread_settings_applied", thread_settings: { model: "gpt-5.6-sol", approval_policy: "never", reasoning_effort: "high", collaboration_mode: { mode: "plan" } } }));
    expect([c.meta.model, c.meta.effort, c.meta.permission]).toEqual(["gpt-5.6-sol", "high", "plan"]);
    // a token_count without info (rate limits only) changes nothing
    c.feed(row(3, "event_msg", { type: "token_count", info: null }));
    expect(c.meta.context).toBe(500);
  });

  it("keeps commands left running as background tasks until they exit", () => {
    const c = createCodexChat();
    c.feed([
      user(0, "start the server"),
      call(1, "r1", "exec_command", { cmd: "npm run dev" }),
      out(2, "r1", "Chunk ID: a\nWall time: 10.0 seconds\nProcess running with session ID 43354\nOriginal token count: 2\nOutput:\nready\n"),
      call(3, "r2", "exec_command", { cmd: "npm run build" }),
      out(4, "r2", "Chunk ID: b\nWall time: 30.0 seconds\nProcess running with session ID 7\nOriginal token count: 0\nOutput:\n"),
      call(5, "w1", "write_stdin", { session_id: 7, chars: "" }),
      out(6, "w1", "Chunk ID: c\nWall time: 3.0 seconds\nProcess exited with code 2\nOriginal token count: 1\nOutput:\nbuild failed\n"),
    ].join("\n"));
    expect(c.meta.tasks.map((t) => [t.id, t.label, t.state])).toEqual([
      ["s43354", "npm run dev", "running"],
      ["s7", "npm run build", "failed"],
    ]);
  });

  it("marks stops and compactions, the plan, web searches, and names other tools plainly", () => {
    const c = createCodexChat();
    c.feed([
      user(0, "plan it"),
      call(1, "u1", "update_plan", { plan: [{ step: "one", status: "completed" }, { step: "two", status: "in_progress" }] }),
      out(2, "u1", "Plan updated"),
      item(3, { type: "web_search_call", status: "completed", action: { type: "search", query: "tauri updater" } }),
      row(4, "event_msg", { type: "turn_aborted", reason: "interrupted" }),
      row(5, "compacted", { message: "" }),
    ].join("\n"));
    expect(c.meta.todos).toEqual([{ text: "one", state: "completed" }, { text: "two", state: "in_progress" }]);
    expect(c.items.map((i) => (i.kind === "step" ? `${i.verb} ${i.target}` : `${i.kind}:${"text" in i ? i.text : ""}`))).toEqual([
      "user:plan it", "Updated the plan 1 of 2 done", "Searched the web for tauri updater", "note:You stopped the agent", "note:Conversation compacted",
    ]);
    expect(describeCodexTool("exec", 'const r = await tools.exec_command({"cmd":"git status","workdir":"D:\\\\app"});')).toMatchObject({ verb: "Ran", target: "git status" });
    expect(describeCodexTool("shell", { command: ["bash", "-lc", "ls -la"] })).toMatchObject({ verb: "Ran", target: "ls -la" });
    expect(describeCodexTool("take_snapshot", {}, "mcp__chrome_devtools__")).toMatchObject({ verb: "Used", target: "chrome devtools · take snapshot" });
  });

  it("reads JS cells: the commands they run, a patch they apply, their nested output headers", () => {
    const cell = 'const r = await tools.shell_command({command:"rtk git status",workdir:"D:\\\\app"});\nconst s = await tools.exec_command({cmd:"npm test"});';
    expect(describeCodexTool("exec", cell)).toMatchObject({ verb: "Ran", target: "rtk git status (+1 more)", full: "rtk git status\nnpm test" });
    const c = createCodexChat();
    c.feed([
      user(0, "go"),
      item(1, { type: "custom_tool_call", call_id: "j1", name: "exec", input: cell }),
      item(2, { type: "custom_tool_call_output", call_id: "j1", output: [{ type: "input_text", text: "Script completed\nWall time 3.1 seconds\nOutput:\n" }, { type: "input_text", text: "Exit code: 0\nWall time: 1.5 seconds\nOutput:\nclean\nExit code: 1\nWall time: 2 seconds\nOutput:\n1 failed" }] }),
      item(3, { type: "custom_tool_call", call_id: "j2", name: "exec", input: "await tools.apply_patch(`*** Begin Patch\n*** Add File: D:/app/x.ts\n+hi\n*** End Patch`);" }),
      item(4, { type: "custom_tool_call_output", call_id: "j2", output: [{ type: "input_text", text: "Script completed\nOutput:\nSuccess." }] }),
    ].join("\n"));
    const [ran, wrote] = steps(c);
    expect([ran.output, ran.error]).toEqual(["clean\n1 failed", true]);
    expect([wrote.verb, wrote.target, wrote.error]).toEqual(["Wrote", "x.ts", false]);
    expect(c.meta.files.map((f) => [f.name, f.isNew])).toEqual([["x.ts", true]]);
  });

  it("shows pictures a tool returned", () => {
    const c = createCodexChat();
    c.feed([
      user(0, "look"),
      call(1, "v1", "view_image", { path: "C:/t/a.png" }),
      out(2, "v1", [{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }]),
    ].join("\n"));
    expect(steps(c)[0]).toMatchObject({ verb: "Looked at", target: "a.png", done: true, images: [{ media: "image/png" }] });
  });
});
