import { describe, it, expect } from "vitest";
import {
  DEFAULT_PIPELINE,
  nextTitle,
  pipelinePrompt,
  staleAssignments,
  planPipeline,
  type PipelineAgent,
} from "./pipeline";
import type { Board, Card } from "./board";

const card = (id: string, over: Partial<Card> = {}): Card => ({
  id,
  title: id,
  desc: "",
  labels: [],
  due: null,
  checklist: [],
  ...over,
});
const board = (lists: { title: string; cards: Card[] }[]): Board => ({
  lists: lists.map((l, i) => ({ id: `l${i}`, title: l.title, cards: l.cards })),
});
const agent = (name: string, running = true): PipelineAgent => ({ id: `a-${name}`, name, running });

describe("nextTitle", () => {
  it("To do → first work stage, then along the pipeline, ending at Done", () => {
    expect(nextTitle(DEFAULT_PIPELINE, "To do")).toBe("Build");
    expect(nextTitle(DEFAULT_PIPELINE, "Build")).toBe("Test");
    expect(nextTitle(DEFAULT_PIPELINE, "Test")).toBe("Review");
    expect(nextTitle(DEFAULT_PIPELINE, "Review")).toBe("Done");
  });
});

describe("pipelinePrompt", () => {
  it("adds the stage instruction and the next-stage move", () => {
    const p = pipelinePrompt("BASE", DEFAULT_PIPELINE, "Build");
    expect(p).toContain("BASE");
    expect(p).toContain("Pipeline stage — Build");
    expect(p).toContain('move this card to "Test"');
  });
  it("the last stage instructs card_done instead of a move", () => {
    expect(pipelinePrompt("BASE", DEFAULT_PIPELINE, "Review")).toContain("card_done");
  });
  it("from To do the effective stage is Build", () => {
    expect(pipelinePrompt("BASE", DEFAULT_PIPELINE, "To do")).toContain("Pipeline stage — Build");
  });
});

describe("staleAssignments", () => {
  it("flags a card that moved to a different stage than it was assigned in", () => {
    const b = board([
      { title: "Build", cards: [card("c1", { assignee: "A" })] },
      { title: "Test", cards: [card("c2", { assignee: "B" })] },
    ]);
    // c1 was assigned in Build (still there → fresh); c2 was assigned in Build
    // but is now in Test → stale.
    const assigned = new Map([
      ["c1", "Build"],
      ["c2", "Build"],
    ]);
    expect(staleAssignments(b, assigned)).toEqual(["c2"]);
  });
  it("flags a card that vanished", () => {
    const b = board([{ title: "Build", cards: [] }]);
    expect(staleAssignments(b, new Map([["gone", "Build"]]))).toEqual(["gone"]);
  });
});

describe("planPipeline", () => {
  it("dispatches unassigned work-stage cards to free agents", () => {
    const b = board([
      { title: "To do", cards: [card("c1")] },
      { title: "Build", cards: [card("c2")] },
    ]);
    const plan = planPipeline(b, [agent("A"), agent("B")], DEFAULT_PIPELINE, new Map());
    expect(plan.dispatches.map((d) => d.cardId).sort()).toEqual(["c1", "c2"]);
  });

  it("treats a stale card as free again and unassigns it", () => {
    const b = board([
      { title: "Build", cards: [] },
      { title: "Test", cards: [card("c1", { assignee: "A" })] }, // moved from Build
    ]);
    const assigned = new Map([["c1", "Build"]]);
    const plan = planPipeline(b, [agent("A")], DEFAULT_PIPELINE, assigned);
    expect(plan.unassign).toEqual(["c1"]);
    // A is now free (its old card is stale) and picks c1 back up for the Test stage.
    expect(plan.dispatches).toEqual([
      { cardId: "c1", agentId: "a-A", agentName: "A", fromTitle: "Test" },
    ]);
  });

  it("keeps an agent busy while its card sits, fresh, in its assigned stage", () => {
    const b = board([{ title: "Build", cards: [card("c1", { assignee: "A" })] }]);
    const plan = planPipeline(b, [agent("A")], DEFAULT_PIPELINE, new Map([["c1", "Build"]]));
    expect(plan.dispatches).toEqual([]);
  });

  it("ignores Done cards and stopped agents", () => {
    const b = board([
      { title: "Build", cards: [card("c1")] },
      { title: "Done", cards: [card("d1")] },
    ]);
    expect(planPipeline(b, [agent("A", false)], DEFAULT_PIPELINE, new Map()).dispatches).toEqual([]);
  });
});
