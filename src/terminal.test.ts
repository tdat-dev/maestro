import { describe, it, expect } from "vitest";
import { mountTerminal } from "./terminal";

// Smoke test: verifies the module (and its @xterm + CSS imports) resolves and
// compiles under the bundler. Real terminal rendering needs a browser and is
// verified manually in the running Tauri app (see M0 plan Task 11/12).
describe("terminal module", () => {
  it("exports mountTerminal as a function", () => {
    expect(typeof mountTerminal).toBe("function");
  });
});
