import { describe, it, expect } from "vitest";
import { mountTerminal } from "./terminal";
import { paletteFor } from "./termtheme";

// Regression guard for the 0.5.5 spawn-breaking bug: the Unicode 11 addon
// registers a width provider through xterm's proposed unicode API, so the
// Terminal must be constructed with allowProposedApi. Without it, loadAddon()
// throws inside mountTerminal and no pane ever shows a terminal. This test
// exercises the REAL mountTerminal (the previous terminal.test.ts never did),
// so a missing allowProposedApi flag fails CI instead of shipping.
describe("mountTerminal", () => {
  it("mounts without throwing and activates Unicode 11 widths", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const handle = mountTerminal(div, () => {}, () => {}, { webgl: false });
    expect(handle).toBeTruthy();
    handle.dispose();
  });

  it("mounts a see-through pane too (DOM renderer path)", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const look = { theme: paletteFor("light", 0.6), stripPlate: true };
    const handle = mountTerminal(div, () => {}, () => {}, { webgl: false, look });
    expect(handle).toBeTruthy();
    handle.dispose();
  });
});
