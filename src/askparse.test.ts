import { describe, expect, it } from "vitest";
import { freeTextKeys, parseAsk } from "./askparse";

// Screens as TerminalHandle.snapshot() returns them: rendered rows, newest last.
// The Claude question follows the exact layout captured from a real session
// recording (header chip, question, numbered options with descriptions,
// "Type something." / "Chat about this", key hint); only the wording is neutral.

const CLAUDE_BASH = `
● Deriver is green. Now I need the Rust side to emit output timestamps.

╭──────────────────────────────────────────────────────────────────────╮
│ Bash command                                                         │
│                                                                      │
│   npm run tauri build -- --debug                                     │
│   Build a debug binary to check the new events                       │
│                                                                      │
│ Do you want to proceed?                                              │
│ ❯ 1. Yes                                                             │
│   2. Yes, and don't ask again for npm run tauri build commands in D:\\maestro │
│   3. No, and tell Claude what to do differently (esc)                │
╰──────────────────────────────────────────────────────────────────────╯
`;

// Newer Claude Code drops the box.
const CLAUDE_BASH_UNBOXED = `
 Bash command

   git push origin feat/agent-inbox
   Push the branch

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for git push commands in D:\\maestro
   3. No, and tell Claude what to do differently (esc)
`;

const CLAUDE_EDIT = `
 Edit file
 src/taskstate.ts
   12 -  return "idle";
   12 +  return hasDiff ? "review" : "idle";

 Do you want to make this edit to taskstate.ts?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No, and tell Claude what to do differently (esc)
`;

const CLAUDE_QUESTION = `
  Đây là thay đổi lớn nên tôi muốn chốt 1 điểm trước khi làm:
────────────────────────────────────────────────────────────────── [ ] Cách ship
Chốt cách đưa tính năng lên bản chính thức?
> 1. Tách riêng rồi mở MR vào main (Khuyến nghị)
     Tạo nhánh mới từ main, chỉ mang đúng thư mục cần thiết sang, build và test rồi mở MR.
  2. Merge cả develop vào main
     Ship cùng lúc mọi tính năng chưa lên prod. Xung đột nhiều, rủi ro cao.
  3. Khoan, chỉ báo cáo
     Chưa đổi gì, tôi trình bày chi tiết để anh quyết.
  4. Type something.
──────────────────────────────────────────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

const CODEX_RUN = `
  Would you like to run the following command?

  Reason: build the frontend to check the types

  $ npm run build

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (a)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`;

const GEMINI_RUN = `
╭──────────────────────────────────────────────────────────╮
│ ?  Shell npm run test [in D:\\ByteWaker] (Run the tests)  │
│                                                          │
│ npm run test                                             │
│                                                          │
│ Allow execution of: 'npm'?                               │
│                                                          │
│ ● 1. Yes, allow once                                     │
│   2. Yes, allow always ...                               │
│   3. No, suggest changes (esc)                           │
╰──────────────────────────────────────────────────────────╯
`;

// A numbered plan in the agent's own reply, followed by the empty input box:
// nothing to answer, even though the reply ends with a question.
const PROSE_LIST = `
● Here's the plan:
  1. Find the handler
  2. Add the check
  3. Add a test
  Do you want me to go ahead?

╭──────────────────────────────────────────────╮
│ >                                            │
╰──────────────────────────────────────────────╯
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

const WORKING = `
● Update(src/taskstate.ts)
  ⎿  Updated src/taskstate.ts with 4 additions
✻ Cogitating… (38s · ↓ 1.2k tokens · esc to interrupt)
`;

describe("parseAsk: permission prompts", () => {
  it("reads Claude's boxed Bash prompt", () => {
    const a = parseAsk(CLAUDE_BASH)!;
    expect(a.kind).toBe("run");
    expect(a.prompt).toBe("Do you want to proceed?");
    expect(a.detail).toBe("npm run tauri build -- --debug");
    expect(a.options.map((o) => o.key)).toEqual(["1", "2", "\x1b"]);
    expect(a.options[1].always).toBe(true);
    expect(a.options[2].deny).toBe(true);
    expect(a.options[2].label).toBe("No, and tell Claude what to do differently");
  });

  it("reads the unboxed layout newer Claude Code draws", () => {
    const a = parseAsk(CLAUDE_BASH_UNBOXED)!;
    expect(a.kind).toBe("run");
    expect(a.detail).toBe("git push origin feat/agent-inbox");
    expect(a.options).toHaveLength(3);
  });

  it("tells an edit apart from a command and names the file", () => {
    const a = parseAsk(CLAUDE_EDIT)!;
    expect(a.kind).toBe("edit");
    expect(a.detail).toBe("taskstate.ts");
    expect(a.options[1].always).toBe(true);
    expect(a.options[1].label).toBe("Yes, allow all edits during this session");
  });

  it("reads Codex's prompt, its command and its letter shortcuts", () => {
    const a = parseAsk(CODEX_RUN)!;
    expect(a.kind).toBe("run");
    expect(a.prompt).toBe("Would you like to run the following command?");
    expect(a.detail).toBe("npm run build");
    expect(a.options.map((o) => o.key)).toEqual(["y", "a", "\x1b"]);
    expect(a.options[0].label).toBe("Yes, proceed");
  });

  it("reads Gemini's shell prompt", () => {
    const a = parseAsk(GEMINI_RUN)!;
    expect(a.kind).toBe("run");
    expect(a.prompt).toBe("Allow execution of: 'npm'?");
    expect(a.detail).toBe("npm run test");
    expect(a.options[0].label).toBe("Yes, allow once");
    expect(a.options[1].always).toBe(true);
    expect(a.options[2].deny).toBe(true);
  });
});

describe("parseAsk: questions", () => {
  it("reads Claude's multiple-choice question with its header and free-text row", () => {
    const a = parseAsk(CLAUDE_QUESTION)!;
    expect(a.kind).toBe("question");
    expect(a.title).toBe("Cách ship");
    expect(a.prompt).toBe("Chốt cách đưa tính năng lên bản chính thức?");
    expect(a.options.map((o) => o.label)).toEqual([
      "Tách riêng rồi mở MR vào main (Khuyến nghị)",
      "Merge cả develop vào main",
      "Khoan, chỉ báo cáo",
    ]);
    expect(a.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
    expect(a.freeTextOption).toBe(4);
  });

  it("answers in free text through the CLI's 'Type something' row", () => {
    const a = parseAsk(CLAUDE_QUESTION);
    expect(freeTextKeys(a, "Làm theo cách 1\nnhưng chưa lên prod")).toEqual(["4", "Làm theo cách 1 nhưng chưa lên prod", "\r"]);
    expect(freeTextKeys(null, "go ahead")).toEqual(["go ahead", "\r"]);
  });
});

describe("parseAsk: nothing to answer", () => {
  it("ignores a numbered list in the agent's own reply", () => {
    expect(parseAsk(PROSE_LIST)).toBeNull();
  });

  it("ignores a working agent", () => {
    expect(parseAsk(WORKING)).toBeNull();
  });

  it("ignores an empty screen and a single numbered line", () => {
    expect(parseAsk("")).toBeNull();
    expect(parseAsk("  1. Yes\n  esc to cancel")).toBeNull();
  });

  it("ignores options that are followed by more conversation", () => {
    const moved = CLAUDE_BASH_UNBOXED + "\n● Ran git push\n  ⎿  Everything up-to-date\n";
    expect(parseAsk(moved)).toBeNull();
  });

  it("reads an arrow-key menu with no numbers, like Claude's trust screen", () => {
    const screen = [
      " Accessing workspace:",
      "",
      " C:\\Users\\tvmar",
      "",
      " Quick safety check: Is this a project you created or one you trust? (Like your own code, a",
      " well-known open source project, or work from your team).",
      "",
      " Security guide",
      "",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      "",
      " Enter to confirm · Esc to cancel",
      "", "", "", "", "", "", "", "", "", "",
    ].join("\n");
    const a = parseAsk(screen)!;
    expect(a.kind).toBe("question");
    expect(a.prompt).toBe("Quick safety check: Is this a project you created or one you trust?");
    expect(a.options.map((o) => [o.label, o.key, !!o.deny])).toEqual([
      ["No, exit", "\r", true],
      ["Yes, I trust this folder", "\x1b[B\r", false],
    ]);
  });

  it("does not read a menu once the agent has moved on below it", () => {
    expect(parseAsk(" ❯ No, exit\n   Yes\n\n Enter to confirm · Esc to cancel\n\n > next thing")).toBeNull();
  });
});
