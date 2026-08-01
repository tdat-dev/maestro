// These laws travel through `cmd /c ... --append-system-prompt <text>`. A single
// unescaped metacharacter there does not raise anything: the agent boots, looks
// completely normal, and silently has no laws — no board, no dispatch protocol.
// That failure is invisible from the outside, so it gets a test.

import { describe, it, expect } from "vitest";
import { MAESTRO_LAWS, DIRECTOR_LAWS } from "./laws";

const LAWS = { MAESTRO_LAWS, DIRECTOR_LAWS };

describe("agent laws", () => {
  for (const [name, text] of Object.entries(LAWS)) {
    it(`${name} survives the cmd /c launch path`, () => {
      expect(text).not.toMatch(/[&|<>%!^()"']/);
      expect(text).not.toMatch(/[\r\n]/);
    });
  }

  it("sends the director to the agents that are already open before it spawns", () => {
    // The whole point of the rewrite: the crew on screen IS the crew. Spawning
    // for work an idle pane could take is how 4 panes become 12.
    const i = DIRECTOR_LAWS.indexOf("fleet_status");
    const j = DIRECTOR_LAWS.indexOf("agent_spawn");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(DIRECTOR_LAWS).toContain("ALREADY OPEN");
    expect(DIRECTOR_LAWS).toMatch(/agent_spawn ONLY when/);
  });

  it("leaves the worker taking orders from the person, not only the director", () => {
    expect(MAESTRO_LAWS).toMatch(/person always outranks the Director/);
  });

  // The fleet talks to itself in English so a hand-off never needs translating;
  // the person still gets answered in their own language. Both halves matter —
  // an English-only rule with no second half turns the agents monolingual at
  // the user too.
  for (const [name, text] of Object.entries(LAWS)) {
    it(`${name} sends fleet_send hand-offs in English and answers the person in theirs`, () => {
      expect(text).toMatch(/fleet_send must be written in English/);
      expect(text).toMatch(/language they used/);
    });
  }
});
