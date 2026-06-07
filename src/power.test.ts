import { describe, it, expect, vi, beforeEach } from "vitest";
import { shouldPauseAnimations, initIdleAnimationPause } from "./power";

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

describe("initIdleAnimationPause resume hook", () => {
  let focused = true;
  beforeEach(() => {
    focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
  });

  it("fires onResume once per idle→active transition, not on every focus", () => {
    const onResume = vi.fn();
    initIdleAnimationPause(onResume);

    // Starts active — nothing to repaint on first paint.
    expect(onResume).toHaveBeenCalledTimes(0);

    // Window loses focus (idle) — still no resume.
    focused = false;
    window.dispatchEvent(new Event("blur"));
    expect(onResume).toHaveBeenCalledTimes(0);

    // Window regains focus — exactly one repaint. This is the path that rescues
    // the black screen after a long idle / display sleep / tray stint.
    focused = true;
    window.dispatchEvent(new Event("focus"));
    expect(onResume).toHaveBeenCalledTimes(1);

    // A redundant focus while already active must NOT trigger another repaint.
    window.dispatchEvent(new Event("focus"));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
