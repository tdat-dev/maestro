// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  gitRepoRoot: async (dir: string) => (dir.startsWith("D:\\repo") ? "D:\\repo" : null),
  pickFolder: async () => null,
  sendMessage: async () => {},
}));

import { DEFAULTS, getPref, getPrefs, onPrefs, resetPrefs, setPref } from "./prefs";
import { initPrefsView, resetPrefsView, syncPrefsView } from "./prefsview";
import { loadCrew, prepareIsolation } from "./spawnmodal";
import type { Workspace } from "./panetypes";

beforeEach(() => localStorage.clear());

describe("prefs", () => {
  it("lifts a saved Split size of 4, the old cap, to the new default once", () => {
    localStorage.setItem("maestro.prefs", JSON.stringify({ splitMax: 4, jobDelay: 7 }));
    expect(getPrefs()).toMatchObject({ splitMax: 6, jobDelay: 7 });
    setPref("splitMax", 4);
    expect(getPref("splitMax")).toBe(4);
  });

  it("ships with defaults and keeps values in range", () => {
    expect(getPrefs()).toEqual(DEFAULTS);
    setPref("jobDelay", 99);
    expect(getPref("jobDelay")).toBe(20);
    setPref("splitMax", 7 as never);
    expect(getPref("splitMax")).toBe(6);
    localStorage.setItem("maestro.prefs", "{broken");
    expect(getPrefs()).toEqual(DEFAULTS);
  });

  it("tells listeners and resets", () => {
    const seen: boolean[] = [];
    const off = onPrefs((p) => seen.push(p.notifyNeeds));
    setPref("notifyNeeds", false);
    resetPrefs();
    off();
    expect(seen).toEqual([false, true]);
  });

  it("runs agents in the project folder; their own branch only in git projects, and only when asked", async () => {
    const ws = (dir: string) => ({ dir, repoRoot: null, isolated: false }) as unknown as Workspace;
    const byDefault = ws("D:\\repo\\app");
    await prepareIsolation(byDefault);
    expect(byDefault.isolated).toBe(false);
    setPref("worktree", true);
    const repo = ws("D:\\repo\\app");
    await prepareIsolation(repo);
    expect([repo.repoRoot, repo.isolated]).toEqual(["D:\\repo", true]);
    const plain = ws("D:\\notes");
    await prepareIsolation(plain);
    expect(plain.isolated).toBe(false);
  });

  it("turns off a worktree each, the old default, once; asking for it again sticks", () => {
    localStorage.setItem("maestro.prefs", JSON.stringify({ worktree: true, jobDelay: 7 }));
    expect(getPrefs()).toMatchObject({ worktree: false, jobDelay: 7 });
    setPref("worktree", true);
    expect(getPref("worktree")).toBe(true);
  });
});

describe("Settings rows", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <select id="prefDefaultCli"></select>
      <div id="prefDefaultCount"><button data-v="1"></button><button data-v="2"></button><button data-v="3"></button></div>
      <div id="prefSplitMax"><button data-v="2"></button><button data-v="3"></button><button data-v="4"></button><button data-v="6"></button><button data-v="9"></button></div>
      <div id="prefJobDelay"><button data-dec></button><span data-n></span><button data-inc></button></div>
      <input type="checkbox" id="prefAsk"><input type="checkbox" id="prefWorktree"><input type="checkbox" id="prefNotify">
      <input type="checkbox" id="prefDirector"><input type="checkbox" id="prefJump"><input type="checkbox" id="prefAskCard">
      <input type="checkbox" id="prefReviewOnDone"><input type="checkbox" id="prefRestore"><button id="prefReset"></button>`;
    initPrefsView();
  });

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  it("shows the saved values", () => {
    expect($<HTMLSelectElement>("prefDefaultCli").options[0].value).toBe("last");
    expect($<HTMLSelectElement>("prefDefaultCli").querySelector('option[value="powershell"]')).toBeNull();
    expect($<HTMLInputElement>("prefWorktree").checked).toBe(false);
    expect($<HTMLInputElement>("prefAsk").checked).toBe(true);
    expect($("prefJobDelay").querySelector("[data-n]")!.textContent).toBe("4 s");
    expect($("prefSplitMax").querySelector(".on")!.getAttribute("data-v")).toBe("6");
  });

  it("saves every change straight away", () => {
    const cli = $<HTMLSelectElement>("prefDefaultCli");
    cli.value = "codex"; cli.dispatchEvent(new Event("change"));
    ($("prefDefaultCount").querySelector('[data-v="3"]') as HTMLButtonElement).click();
    ($("prefSplitMax").querySelector('[data-v="2"]') as HTMLButtonElement).click();
    ($("prefJobDelay").querySelector("[data-inc]") as HTMLButtonElement).click();
    const notify = $<HTMLInputElement>("prefNotify");
    notify.checked = false; notify.dispatchEvent(new Event("change"));
    const ask = $<HTMLInputElement>("prefAsk");
    ask.checked = false; ask.dispatchEvent(new Event("change"));
    expect(getPrefs()).toMatchObject({ defaultCli: "codex", defaultCount: 3, splitMax: 2, jobDelay: 5, notifyNeeds: false });
    expect(loadCrew().skipPerms).toBe(true);
    // Reset asks first (Settings), then puts these back
    resetPrefsView();
    expect(getPrefs()).toEqual(DEFAULTS);
    expect(loadCrew().skipPerms).toBe(false);
    syncPrefsView();
    expect($<HTMLInputElement>("prefNotify").checked).toBe(true);
  });
});
