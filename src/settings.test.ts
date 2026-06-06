import { describe, it, expect, beforeEach } from "vitest";
import { getHideToTray, setHideToTray } from "./settings";

describe("hideToTray setting", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to off", () => {
    expect(getHideToTray()).toBe(false);
  });

  it("round-trips on/off", () => {
    setHideToTray(true);
    expect(getHideToTray()).toBe(true);
    setHideToTray(false);
    expect(getHideToTray()).toBe(false);
  });

  it("persists under the maestro.hideToTray key", () => {
    setHideToTray(true);
    expect(localStorage.getItem("maestro.hideToTray")).toBe("1");
  });
});
