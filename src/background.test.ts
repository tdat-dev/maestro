// The wallpaper is app-wide. These tests guard the part of that change with
// teeth: the one-time promotion of a per-workspace choice. Getting it wrong
// doesn't throw — it silently reverts someone to the default preset and looks
// exactly like "the setting didn't save".

import { describe, it, expect, beforeEach } from "vitest";
import { initBackground, backdropRgb, paneTone } from "./background";

const KEY = "maestro.canvasBg";
const LOOK_KEY = "maestro.paneLook";

const spec = (kind: string, value: string, avg?: number[]) => JSON.stringify({ kind, value, avg });

/** initBackground() also wires the picker; with no picker markup in the DOM the
 *  listeners simply find nothing, which leaves the migration under test alone. */
function boot(): void {
  initBackground();
}

describe("app-wide background", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("promotes a per-workspace wallpaper to the global key", () => {
    localStorage.setItem(`${KEY}.D:\\proj`, spec("color", "#ffffff"));
    boot();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ kind: "color", value: "#ffffff" });
  });

  it("clears the per-workspace keys it migrated, so it only runs once", () => {
    localStorage.setItem(`${KEY}.D:\\a`, spec("color", "#ffffff"));
    localStorage.setItem(`${LOOK_KEY}.D:\\a`, JSON.stringify({ tone: "auto", opacity: 0.2 }));
    boot();
    expect(localStorage.getItem(`${KEY}.D:\\a`)).toBeNull();
    expect(localStorage.getItem(`${LOOK_KEY}.D:\\a`)).toBeNull();
  });

  it("prefers an uploaded image over a preset when workspaces disagree", () => {
    // A preset is often just whatever was there; a photo was chosen on purpose.
    localStorage.setItem(`${KEY}.D:\\a`, spec("preset", "ocean"));
    localStorage.setItem(`${KEY}.D:\\b`, spec("image", "data:image/jpeg;base64,xx", [200, 200, 200]));
    boot();
    expect(JSON.parse(localStorage.getItem(KEY)!).kind).toBe("image");
  });

  it("carries the look from the SAME workspace as the wallpaper it took", () => {
    // A tone picked for one photo says nothing about another.
    localStorage.setItem(`${KEY}.D:\\a`, spec("preset", "ocean"));
    localStorage.setItem(`${LOOK_KEY}.D:\\a`, JSON.stringify({ tone: "light", opacity: 0.9 }));
    localStorage.setItem(`${KEY}.D:\\b`, spec("image", "data:image/jpeg;base64,xx", [240, 240, 240]));
    localStorage.setItem(`${LOOK_KEY}.D:\\b`, JSON.stringify({ tone: "dark", opacity: 0 }));
    boot();
    expect(JSON.parse(localStorage.getItem(LOOK_KEY)!)).toMatchObject({ tone: "dark" });
  });

  it("leaves an already-global choice alone", () => {
    localStorage.setItem(KEY, spec("color", "#000000"));
    localStorage.setItem(`${KEY}.D:\\a`, spec("color", "#ffffff"));
    boot();
    expect(JSON.parse(localStorage.getItem(KEY)!).value).toBe("#000000");
  });

  it("reads the wallpaper without being told which workspace is asking", () => {
    // The signature IS the feature: nothing downstream can key the tone to a
    // workspace, so no tab can drift from the picture the others are showing.
    localStorage.setItem(KEY, spec("color", "#ffffff"));
    expect(backdropRgb()).toEqual([255, 255, 255]);
    expect(paneTone()).toBe("dark"); // dark ink on a white wallpaper
  });
});
