import { describe, expect, it } from "vitest";
import { applyMention, mentionAt, mentionMatches, withFolders } from "./mention";

describe("@ mentions", () => {
  it("finds the @word being typed, not an email or a finished one", () => {
    expect(mentionAt("look at @src/ch", 15)).toEqual({ start: 8, query: "src/ch" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("mail me@home", 12)).toBeNull();
    expect(mentionAt("@done now", 9)).toBeNull();
  });

  it("offers files and their folders, the name before the path, short before long", () => {
    const all = withFolders(["src/chatview.ts", "src/chatmodel.ts", "src/styles/chat.css", "docs/chat-notes.md", "README.md"]);
    expect(all.filter((h) => h.folder).map((h) => h.path).sort()).toEqual(["docs/", "src/", "src/styles/"]);
    expect(mentionMatches(all, "chatv").map((h) => h.path)).toEqual(["src/chatview.ts"]);
    expect(mentionMatches(all, "chat").map((h) => h.path).slice(0, 3)).toEqual(["src/styles/chat.css", "src/chatview.ts", "src/chatmodel.ts"]);
    expect(mentionMatches(all, "styles").map((h) => h.path)[0]).toBe("src/styles/");
    // letters in order, for a quick abbreviation
    expect(mentionMatches(all, "cvw").map((h) => h.path)).toEqual(["src/chatview.ts"]);
    expect(mentionMatches(all, "zzz")).toEqual([]);
  });

  it("puts the pick in place of the @word, with a space after, quoting a path with spaces", () => {
    expect(applyMention("see @cha now", 4, 8, "src/chatview.ts")).toEqual({ text: "see @src/chatview.ts now", caret: 21 });
    expect(applyMention("@x", 0, 2, "My Docs/a.md")).toEqual({ text: '@"My Docs/a.md" ', caret: 16 });
  });
});
