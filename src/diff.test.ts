import { describe, it, expect } from "vitest";
import { parseDiff } from "./diff";

const SAMPLE = `diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;

describe("parseDiff", () => {
  it("returns one file with its path and counts", () => {
    const files = parseDiff(SAMPLE);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/app.ts");
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
  });

  it("parses hunk lines with kinds", () => {
    const h = parseDiff(SAMPLE)[0].hunks[0];
    expect(h.header).toBe("@@ -1,3 +1,4 @@");
    expect(h.lines.map((l) => l.kind)).toEqual(["ctx", "del", "add", "add", "ctx"]);
    expect(h.lines[2].text).toBe("const b = 3;");
  });

  it("returns [] for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});
