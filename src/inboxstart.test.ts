// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ created: [] as string[], activated: [] as string[], newAgent: [] as Array<number | undefined>, recents: [] as string[] }));
vi.mock("./workspace", () => ({
  createWorkspace: (dir: string) => { calls.created.push(dir); return { id: "new", dir, panes: new Map() }; },
  activateWorkspace: (ws: { id: string }) => { calls.activated.push(ws.id); },
}));
vi.mock("./ipc", () => ({ pickFolder: async () => "D:\\new" }));
vi.mock("./recents", () => ({ getRecents: () => ["D:\\maestro", "D:\\quy"], addRecent: (d: string) => { calls.recents.push(d); } }));
vi.mock("./inboxnew", () => ({ openNewAgent: (o: { count?: number } = {}) => { calls.newAgent.push(o.count); } }));
vi.mock("./spawnmodal", () => ({ quickTerminal: (dir: string | null) => { calls.created.push(`shell:${dir}`); } }));
vi.mock("./tasks", () => ({
  allTasks: () => [
    { paneId: "a", wsId: "ws-1", status: { state: "needs" } },
    { paneId: "b", wsId: "ws-1", status: { state: "working" } },
  ],
}));

import { workspaces } from "./appstate";
import { folderName, mountStart, projectLine, unmountStart } from "./inboxstart";
import type { Workspace } from "./panetypes";

describe("start screen", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="home"></div>`;
    calls.created.length = calls.activated.length = calls.newAgent.length = calls.recents.length = 0;
    workspaces.clear();
    workspaces.set("ws-1", { id: "ws-1", dir: "D:\\maestro\\", panes: new Map([["a", {}], ["b", {}]]) } as unknown as Workspace);
    unmountStart();
  });

  it("names projects by folder and counts their agents", () => {
    expect(folderName("D:\\WhaleloSource\\")).toBe("WhaleloSource");
    expect(projectLine("D:\\maestro", [
      { wsId: "ws-1", status: { state: "needs" } }, { wsId: "ws-1", status: { state: "idle" } },
    ] as never)).toEqual({ agents: 2, needs: 1 });
  });

  it("lists recent projects with what waits on you, and switches to an open one", () => {
    mountStart();
    const rows = [...document.querySelectorAll(".st-rec")];
    expect(rows.map((r) => r.querySelector("b")!.textContent)).toEqual(["maestro", "quy"]);
    expect(rows[0].querySelector(".st-n")!.textContent).toBe("2 agents · 1 needs you");
    expect(rows[1].querySelector(".st-n")!.textContent).toBe("Not open");
    (rows[0] as HTMLButtonElement).click();
    expect(calls.activated).toEqual(["ws-1"]);
    expect(calls.newAgent).toEqual([]); // it already has agents
    (rows[1] as HTMLButtonElement).click();
    expect(calls.created).toEqual(["D:\\quy"]);
    expect(calls.newAgent).toEqual([undefined]); // a fresh project asks for its first agent
  });

  it("starts a race of three in a folder you choose", async () => {
    mountStart();
    (document.querySelector('[data-st="race"]') as HTMLButtonElement).click();
    await Promise.resolve(); await Promise.resolve();
    expect(calls.created).toEqual(["D:\\new"]);
    expect(calls.recents).toEqual(["D:\\new"]);
    expect(calls.newAgent).toEqual([3]);
  });

  it("opens a plain terminal in the latest project folder", () => {
    mountStart();
    (document.querySelector('[data-st="shell"]') as HTMLButtonElement).click();
    expect(calls.created).toEqual(["shell:D:\\maestro"]);
  });
});
