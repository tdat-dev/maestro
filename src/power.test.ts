import { describe, it, expect } from "vitest";
import { shouldPauseAnimations } from "./power";

describe("shouldPauseAnimations", () => {
  it("runs animations only when visible AND focused", () => {
    expect(shouldPauseAnimations(false, true)).toBe(false);
  });
  it("pauses when the window is hidden", () => {
    expect(shouldPauseAnimations(true, true)).toBe(true);
  });
  it("pauses when the window is unfocused", () => {
    expect(shouldPauseAnimations(false, false)).toBe(true);
  });
});
