import { describe, it, expect, beforeEach } from "vitest";
import {
  pushFlow,
  flowLog,
  clearFlow,
  clampText,
  toLabel,
  fmtTime,
  createFlow,
  FLOW_MAX,
} from "./flow";

const mk = (over: Partial<Parameters<typeof pushFlow>[0]> = {}) =>
  pushFlow({ from: "Director", to: "Bob", targets: [], text: "do the thing", ...over });

beforeEach(() => clearFlow());

describe("flow buffer", () => {
  it("keeps the newest FLOW_MAX messages and drops the oldest", () => {
    for (let i = 0; i < FLOW_MAX + 40; i += 1) mk({ text: `msg ${i}` });
    const log = flowLog();
    expect(log.length).toBe(FLOW_MAX);
    expect(log[0].text).toBe(`msg 40`);
    expect(log[log.length - 1].text).toBe(`msg ${FLOW_MAX + 39}`);
  });

  it("stamps a rising id so a reopened panel can append only what it missed", () => {
    const a = mk();
    const b = mk();
    expect(b.id).toBeGreaterThan(a.id);
  });
});

describe("clampText", () => {
  it("trims and ellipsizes past the cap", () => {
    expect(clampText("  hi  ", 10)).toBe("hi");
    expect(clampText("abcdefghij", 5)).toBe("abcd…");
  });

  it("caps what gets stored, not just what gets shown", () => {
    const m = mk({ text: "x".repeat(9000) });
    expect(m.text.length).toBeLessThan(9000);
  });
});

describe("toLabel", () => {
  it("names the addressed agent", () => {
    expect(toLabel({ to: "Bob", targets: [] })).toBe("Bob");
  });

  it("reads a broadcast as everyone, with the headcount it reached", () => {
    const t = (name: string) => ({ wsId: "w", paneId: name, name });
    expect(toLabel({ to: null, targets: [t("a"), t("b"), t("c")] })).toBe("everyone (3)");
  });

  it("names the single agent a broadcast actually reached", () => {
    expect(toLabel({ to: null, targets: [{ wsId: "w", paneId: "p", name: "Solo" }] })).toBe("Solo");
  });
});

describe("flow panel", () => {
  function mount() {
    const body = document.createElement("div");
    const actions = document.createElement("div");
    const rail = document.createElement("button");
    const tool = createFlow();
    tool.mount(body, actions);
    tool.attachBadge(rail);
    return { tool, body, rail, badge: rail.querySelector("span") as HTMLElement };
  }

  it("builds no rows while it is closed — just a count on the rail", () => {
    const { body, badge } = mount();
    mk();
    mk();
    expect(body.querySelectorAll(".flow-row").length).toBe(0);
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("2");
  });

  it("renders what it missed when you open it, and clears the count", () => {
    const { tool, body, badge } = mount();
    mk({ text: "one" });
    mk({ text: "two" });
    tool.show();
    expect(body.querySelectorAll(".flow-row").length).toBe(2);
    expect(badge.hidden).toBe(true);
    // Open panel: a new message lands as a row, not as an unread count.
    mk({ text: "three" });
    expect(body.querySelectorAll(".flow-row").length).toBe(3);
    expect(badge.hidden).toBe(true);
  });

  it("stops rendering again once you close it", () => {
    const { tool, body } = mount();
    tool.show();
    mk();
    tool.hide();
    mk();
    expect(body.querySelectorAll(".flow-row").length).toBe(1);
  });
});

describe("fmtTime", () => {
  it("pads to a fixed-width mono stamp", () => {
    const d = new Date(2026, 0, 2, 9, 5, 4);
    expect(fmtTime(d.getTime())).toBe("09:05:04");
  });
});
