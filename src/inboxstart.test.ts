// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  created: [] as string[], activated: [] as string[], newAgent: [] as Array<number | undefined>,
  recents: [] as string[], spawned: [] as Array<[string, string, number, string | null, boolean]>,
  revealed: [] as string[], recentList: ["D:\\maestro", "D:\\quy"] as string[],
}));
vi.mock("./workspace", () => ({
  createWorkspace: (dir: string) => { calls.created.push(dir); return { id: "new", dir, panes: new Map() }; },
  activateWorkspace: (ws: { id: string }) => { calls.activated.push(ws.id); },
}));
vi.mock("./ipc", () => ({ pickFolder: async () => "D:\\new" }));
vi.mock("./recents", () => ({ getRecents: () => calls.recentList, addRecent: (d: string) => { calls.recents.push(d); } }));
vi.mock("./inboxnew", () => ({ openNewAgent: (o: { count?: number } = {}) => { calls.newAgent.push(o.count); } }));
vi.mock("./spawnmodal", () => ({
  loadCrew: () => ({ skipPerms: false }),
  presetAvailable: (program: string) => program !== "goose",
  quickTerminal: (dir: string | null) => { calls.created.push(`shell:${dir}`); },
  spawnAgents: async (ws: { id: string }, cli: string, n: number, task: string | null, skip: boolean) => { calls.spawned.push([ws.id, cli, n, task, skip]); return []; },
}));
vi.mock("./agentbridge", () => ({ revealPane: (ws: string, pane: string) => { calls.revealed.push(`${ws}/${pane}`); return true; } }));
vi.mock("./panelayout", () => ({ focusPane: () => {} }));
vi.mock("./tasks", () => ({
  allTasks: () => [
    { paneId: "a", wsId: "ws-1", name: "Ana", project: "maestro", status: { state: "needs", ask: { kind: "run", prompt: "Do you want to proceed?", detail: "npm test", options: [] } } },
    { paneId: "b", wsId: "ws-1", name: "Bo", project: "maestro", status: { state: "working", ask: null } },
  ],
}));

import { workspaces } from "./appstate";
import { folderName, greeting, mountStart, projectLine, statusSentence, unmountStart } from "./inboxstart";
import type { Workspace } from "./panetypes";

const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

describe("start screen", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="home"></div>`;
    for (const k of ["created", "activated", "newAgent", "recents", "spawned", "revealed"] as const) calls[k].length = 0;
    calls.recentList = ["D:\\maestro", "D:\\quy"];
    localStorage.clear();
    workspaces.clear();
    workspaces.set("ws-1", { id: "ws-1", dir: "D:\\maestro\\", panes: new Map([["a", {}], ["b", {}]]) } as unknown as Workspace);
    unmountStart();
  });

  it("greets by the hour and says in one sentence what waits on you", () => {
    expect([greeting(3), greeting(9), greeting(14), greeting(20)]).toEqual(["Working late", "Good morning", "Good afternoon", "Good evening"]);
    const t = (name: string, state: string) => ({ name, status: { state } }) as never;
    expect(statusSentence([t("Ana", "needs")], false)).toBe("Ana is waiting on you.");
    expect(statusSentence([t("Ana", "needs"), t("Bo", "needs")], false)).toBe("2 agents are waiting on you.");
    expect(statusSentence([t("Bo", "working")], false)).toBe("One agent is working. Nothing needs you yet.");
    expect(statusSentence([], true)).toContain("Pick a folder");
    expect(folderName("D:\\WhaleloSource\\")).toBe("WhaleloSource");
    expect(projectLine("D:\\maestro", [
      { wsId: "ws-1", status: { state: "needs" } }, { wsId: "ws-1", status: { state: "idle" } },
    ] as never)).toEqual({ agents: 2, needs: 1 });
  });

  it("starts an agent on the job in the chosen project with Enter", async () => {
    mountStart();
    expect(document.querySelector(".st-status")!.textContent).toBe("Ana is waiting on you.");
    const job = document.getElementById("stJob") as HTMLTextAreaElement;
    (document.querySelector("[data-starter]") as HTMLButtonElement).click();
    expect(job.value).toContain("Explain how this codebase");
    job.value = "Fix the flaky upload test";
    (document.getElementById("stCli") as HTMLSelectElement).value = "codex";
    (document.getElementById("stCount") as HTMLSelectElement).value = "2";
    job.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(calls.activated).toEqual(["ws-1"]);
    expect(calls.spawned).toEqual([["ws-1", "codex", 2, "Fix the flaky upload test", false]]);
    expect(job.value).toBe("");
    expect(localStorage.getItem("maestro.inbox.lastCli")).toBe("codex");
  });

  it("asks for a folder when you choose one, and opens it as a new project", async () => {
    mountStart();
    (document.getElementById("stDir") as HTMLSelectElement).value = "__choose__";
    (document.getElementById("stJob") as HTMLTextAreaElement).value = "Add tests";
    document.querySelector(".st-compose")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.created).toEqual(["D:\\new"]);
    expect(calls.recents).toEqual(["D:\\new"]);
    expect(calls.spawned[0].slice(0, 2)).toEqual(["new", "claude"]);
  });

  it("lists who waits on you and your projects, and opens each", () => {
    mountStart();
    const wait = document.querySelector(".st-w") as HTMLButtonElement;
    expect(wait.textContent).toContain("Wants to run npm test");
    wait.click();
    expect(calls.revealed).toEqual(["ws-1/a"]);
    const cards = [...document.querySelectorAll(".st-proj[data-dir]")];
    expect(cards.map((c) => c.querySelector("b")!.textContent)).toEqual(["maestro", "quy"]);
    expect(cards[0].querySelector(".st-n")!.textContent).toBe("1 waiting on you");
    expect(cards[1].querySelector(".st-n")!.textContent).toBe("Not open");
    (cards[1] as HTMLButtonElement).click();
    expect(calls.created).toEqual(["D:\\quy"]);
    expect(calls.newAgent).toEqual([undefined]); // a fresh project asks for its first agent
    (document.querySelector('[data-st="shell"]') as HTMLButtonElement).click();
    expect(calls.created).toEqual(["D:\\quy", "shell:D:\\maestro"]);
  });

  it("shows three steps the first time, instead of projects", () => {
    calls.recentList = [];
    workspaces.clear();
    mountStart();
    expect([...document.querySelectorAll(".st-steps b")].map((b) => b.textContent)).toEqual(["Choose a folder", "Say what you want done", "Answer when it asks"]);
    expect(document.querySelector(".st-proj")).toBeNull();
    expect((document.getElementById("stDir") as HTMLSelectElement).value).toBe("__choose__");
  });
});
