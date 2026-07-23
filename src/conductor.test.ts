import { describe, it, expect } from "vitest";
import { planConductor, type ConductorAgent } from "./conductor";
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

const agent = (name: string, running = true): ConductorAgent => ({ id: `a-${name}`, name, running });

describe("planConductor", () => {
  it("off mode does nothing", () => {
    const b = board([{ title: "To do", cards: [card("c1")] }]);
    expect(planConductor("off", b, [agent("A")])).toEqual({ approvals: [], dispatches: [] });
  });

  it("semi pairs free agents with unassigned To do cards", () => {
    const b = board([
      { title: "To do", cards: [card("c1"), card("c2")] },
      { title: "Doing", cards: [] },
    ]);
    const plan = planConductor("semi", b, [agent("A"), agent("B")]);
    expect(plan.approvals).toEqual([]);
    expect(plan.dispatches).toEqual([
      { cardId: "c1", agentId: "a-A", agentName: "A" },
      { cardId: "c2", agentId: "a-B", agentName: "B" },
    ]);
  });

  it("skips agents already on a Doing card and cards already assigned", () => {
    const b = board([
      { title: "To do", cards: [card("c1", { assignee: "A" }), card("c2")] },
      { title: "Doing", cards: [card("d1", { assignee: "A" })] },
    ]);
    // A is busy (Doing d1); only B is free; c1 is already assigned so c2 is next.
    const plan = planConductor("semi", b, [agent("A"), agent("B")]);
    expect(plan.dispatches).toEqual([{ cardId: "c2", agentId: "a-B", agentName: "B" }]);
  });

  it("semi never touches Proposed even when To do is empty", () => {
    const b = board([
      { title: "Proposed", cards: [card("p1")] },
      { title: "To do", cards: [] },
    ]);
    expect(planConductor("semi", b, [agent("A")])).toEqual({ approvals: [], dispatches: [] });
  });

  it("auto approves Proposed cards to feed idle agents, then dispatches them", () => {
    const b = board([
      { title: "Proposed", cards: [card("p1"), card("p2"), card("p3")] },
      { title: "To do", cards: [] },
      { title: "Doing", cards: [] },
    ]);
    const plan = planConductor("auto", b, [agent("A"), agent("B")]);
    expect(plan.approvals).toEqual(["p1", "p2"]); // only as many as there are free agents
    expect(plan.dispatches).toEqual([
      { cardId: "p1", agentId: "a-A", agentName: "A" },
      { cardId: "p2", agentId: "a-B", agentName: "B" },
    ]);
  });

  it("ignores stopped agents", () => {
    const b = board([{ title: "To do", cards: [card("c1")] }]);
    expect(planConductor("semi", b, [agent("A", false)]).dispatches).toEqual([]);
  });
});
