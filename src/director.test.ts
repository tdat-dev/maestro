// The director pane is meant to be the one you can find without looking for it.
// Two halves carry that: CSS (a filled accent plate, verified by eye) and the
// tidy order below, which is the half that can regress silently — nobody notices
// a wrong tile index until the fleet is big enough for it to matter.

import { describe, it, expect } from "vitest";
import { tidyOrder } from "./panelayout";

describe("tidyOrder", () => {
  it("puts the director in the first tile", () => {
    const ids = tidyOrder([
      { id: "a" },
      { id: "b", role: "conductor" },
      { id: "c" },
    ]);
    expect(ids[0]).toBe("b");
  });

  it("keeps the workers in spawn order behind it", () => {
    // Re-tidying must not reshuffle the crew: people navigate by remembered
    // position, and a layout that reorders itself every click is unusable.
    expect(tidyOrder([{ id: "a" }, { id: "b", role: "conductor" }, { id: "c" }])).toEqual(["b", "a", "c"]);
    expect(tidyOrder([{ id: "a" }, { id: "b" }, { id: "c" }])).toEqual(["a", "b", "c"]);
  });

  it("returns every pane exactly once, director or not", () => {
    const panes = [{ id: "a" }, { id: "b", role: "conductor" }, { id: "c" }, { id: "d" }];
    expect(tidyOrder(panes).slice().sort()).toEqual(["a", "b", "c", "d"]);
  });
});
