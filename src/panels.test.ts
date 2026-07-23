import { describe, it, expect } from "vitest";
import { clampWidth } from "./panels";

describe("clampWidth", () => {
  it("clamps below min and above max, passes through in range", () => {
    expect(clampWidth(10, 120, 600)).toBe(120);
    expect(clampWidth(900, 120, 600)).toBe(600);
    expect(clampWidth(300, 120, 600)).toBe(300);
  });
});
