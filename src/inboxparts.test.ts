// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as Array<[string, string, number, string | null, boolean]>);
vi.mock("./spawnmodal", () => ({
  loadCrew: () => ({ skipPerms: false }),
  presetAvailable: (program: string) => program !== "goose",
  spawnAgents: async (ws: { id: string }, cli: string, n: number, task: string | null, skip: boolean) => {
    spawned.push([ws.id, cli, n, task, skip]);
    return [];
  },
}));

import { filterItems, openPalette, paletteOpen, type PaletteItem } from "./inboxpalette";
import { agentPresets, startLabel, openNewAgent } from "./inboxnew";
import { byDay, dayLabel, clock } from "./inboxhistory";
import { setActiveWs } from "./appstate";
import type { Workspace } from "./panetypes";

describe("command palette", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  const items = (log: string[]): PaletteItem[] => [
    { group: "Needs you", label: "Ana", sub: "maestro · Wants to run npm test", run: () => log.push("Ana") },
    { group: "Working", label: "Bo", sub: "quy · Working", run: () => log.push("Bo") },
    { group: "Actions", label: "New agent", run: () => log.push("new") },
  ];

  it("matches every word against the name and the second line", () => {
    expect(filterItems(items([]), "npm").map((i) => i.label)).toEqual(["Ana"]);
    expect(filterItems(items([]), "quy work").map((i) => i.label)).toEqual(["Bo"]);
    expect(filterItems(items([]), "").length).toBe(3);
  });

  it("opens, moves with the arrows and runs the chosen item on Enter", () => {
    const log: string[] = [];
    openPalette(items(log));
    expect(paletteOpen()).toBe(true);
    expect([...document.querySelectorAll(".pal-g")].map((g) => g.textContent)).toEqual(["Needs you", "Working", "Actions"]);
    const input = document.getElementById("palQ") as HTMLInputElement;
    input.value = "agent";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll(".pal-it")).toHaveLength(1);
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(log).toEqual(["Bo"]);
    expect(paletteOpen()).toBe(false);
  });

  it("closes on Escape without running anything", () => {
    const log: string[] = [];
    openPalette(items(log));
    document.getElementById("palQ")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(paletteOpen()).toBe(false);
    expect(log).toEqual([]);
  });
});

describe("New agent", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    spawned.length = 0;
    localStorage.clear();
    setActiveWs({ id: "ws-1", name: "maestro", dir: "D:/maestro", panes: new Map() } as unknown as Workspace);
  });

  it("offers coding CLIs, not shells, and names the button by the count", () => {
    expect(agentPresets().some((p) => p.id === "powershell")).toBe(false);
    expect(agentPresets()[0].id).toBe("claude");
    expect(startLabel(1)).toBe("Start agent");
    expect(startLabel(3)).toBe("Start 3 agents");
  });

  it("starts the chosen CLI with the job, and remembers the CLI", () => {
    openNewAgent();
    expect(document.querySelector<HTMLInputElement>('input[value="goose"]')!.disabled).toBe(true);
    (document.getElementById("naTask") as HTMLTextAreaElement).value = "  fix the upload test  ";
    document.querySelector<HTMLInputElement>('input[name="naCli"][value="codex"]')!.checked = true;
    const two = document.querySelector<HTMLInputElement>('input[name="naCount"][value="2"]')!;
    two.checked = true;
    two.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.querySelector("[data-start]")!.textContent).toBe("Start 2 agents");
    expect(document.querySelector<HTMLElement>("[data-race]")!.hidden).toBe(false);
    document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(spawned).toEqual([["ws-1", "codex", 2, "fix the upload test", false]]);
    expect(document.querySelector(".inbox-modal")).toBeNull();
    expect(localStorage.getItem("maestro.inbox.lastCli")).toBe("codex");
  });
});

describe("History", () => {
  it("groups events by day and writes the time as HH:MM", () => {
    const now = new Date(2026, 8, 23, 20, 0).getTime();
    const y = new Date(2026, 8, 22, 9, 5).getTime();
    const t = new Date(2026, 8, 23, 8, 30).getTime();
    expect(dayLabel(t, now)).toBe("Today");
    expect(dayLabel(y, now)).toBe("Yesterday");
    expect(clock(y)).toBe("09:05");
    const g = byDay([{ at: y, kind: "working", text: "Started working" }, { at: t, kind: "answer", text: "You picked “Yes”" }], now);
    expect(g.map((d) => [d.day, d.events.length])).toEqual([["Yesterday", 1], ["Today", 1]]);
  });
});
