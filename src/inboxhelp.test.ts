import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dock = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("./dock", () => ({ dockToggle: (id: string) => { dock.opened.push(id); } }));

import { HELP, TOOLS, isHelpKey, openHelp, openTool } from "./inboxhelp";
import { resetTips, showTip, tipSeen } from "./tips";
import { setPref } from "./prefs";

const key = (target: Element, init: KeyboardEventInit) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, ...init });
  Object.defineProperty(e, "target", { value: target });
  return e;
};

describe("What Maestro can do", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("opens on ? outside text and terminals, and on Ctrl+/ outside terminals", () => {
    document.body.innerHTML = `<div id="d"></div><input id="i"><div class="xterm"><textarea id="x"></textarea></div>`;
    const $ = (id: string) => document.getElementById(id)!;
    expect(isHelpKey(key($("d"), { key: "?", shiftKey: true }))).toBe(true);
    expect(isHelpKey(key($("i"), { key: "?", shiftKey: true }))).toBe(false);
    expect(isHelpKey(key($("x"), { key: "?", shiftKey: true }))).toBe(false);
    expect(isHelpKey(key($("d"), { key: "/", ctrlKey: true }))).toBe(true);
    expect(isHelpKey(key($("i"), { key: "/", ctrlKey: true }))).toBe(true);
    expect(isHelpKey(key($("x"), { key: "/", ctrlKey: true }))).toBe(false);
    expect(isHelpKey(key($("d"), { key: "/" }))).toBe(false);
  });

  it("lists every section and opens a tool from it", () => {
    const open = vi.fn();
    openHelp(open);
    expect([...document.querySelectorAll(".hp-sec h3")].map((h) => h.textContent)).toEqual(["Tools", ...HELP.map((s) => s.title)]);
    expect(document.querySelectorAll(".hp-tool")).toHaveLength(TOOLS.length);
    (document.querySelector('[data-tool="replays"]') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith("replays");
    expect(document.querySelector(".hp-back")).toBeNull();
  });

  it("reaches every tool: dock panels directly, the rest through Settings", () => {
    document.body.innerHTML = `<button id="setOpenSched"></button><button id="setOpenReplays"></button><button id="setOpenUsage"></button>`;
    const clicked: string[] = [];
    document.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => clicked.push(b.id)));
    dock.opened = [];
    for (const t of TOOLS) openTool(t.id);
    expect(dock.opened).toEqual(["kanban", "flow", "fleet", "pomodoro"]);
    expect(clicked).toEqual(["setOpenSched", "setOpenReplays", "setOpenUsage"]);
  });
});

describe("tips", () => {
  beforeEach(() => { localStorage.clear(); resetTips(); });

  it("shows each tip once and never two close together", () => {
    expect(showTip("menu", "", 100_000)).toBe(true);
    expect(tipSeen("menu")).toBe(true);
    expect(showTip("menu", "", 200_000)).toBe(false);
    expect(showTip("split", "", 105_000)).toBe(false); // too soon after the last
    expect(tipSeen("split")).toBe(false);
    expect(showTip("split", "", 130_000)).toBe(true);
  });

  it("stays quiet when tips are off, and comes back after Show tips again", () => {
    setPref("tips", false);
    expect(showTip("review", "", 1_000_000)).toBe(false);
    setPref("tips", true);
    expect(showTip("review", "", 1_000_000)).toBe(true);
    resetTips();
    expect(tipSeen("review")).toBe(false);
  });
});
