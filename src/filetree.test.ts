// Integration tests for the explorer: a fake filesystem behind the ipc module,
// a real DOM (happy-dom), and the tree driven the way a user drives it — clicks,
// keys, and watcher events.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FsEntry } from "./ipc";

const dir = (name: string): FsEntry => ({ name, is_dir: true, size: 0 });
const file = (name: string): FsEntry => ({ name, is_dir: false, size: 1 });

/** The fake tree every test starts from; individual tests mutate it. */
let fsTree: Record<string, FsEntry[]>;
/** The watcher callback the tree registered, so tests can fire fs-changed. */
let fsChangedCb: ((c: { root: string; dirs: string[]; bulk: boolean }) => void) | null = null;

const ipc = {
  fsReadDir: vi.fn(async (_root: string, path: string) => {
    const key = path === "." ? "" : path;
    const hit = fsTree[key];
    if (!hit) throw new Error("no such dir");
    return hit;
  }),
  fsCreateFile: vi.fn(async () => {}),
  fsCreateDir: vi.fn(async () => {}),
  fsRename: vi.fn(async () => {}),
  fsDelete: vi.fn(async () => {}),
  fsCopy: vi.fn(async () => "copy"),
  fsMove: vi.fn(async () => "moved"),
  fsTrash: vi.fn(async () => {}),
  fsReveal: vi.fn(async () => {}),
  fsOpenExternal: vi.fn(async () => {}),
  watchStart: vi.fn(async () => {}),
  watchStop: vi.fn(async () => {}),
  confirmDialog: vi.fn(async () => true),
  onFsChanged: vi.fn(async (cb: (c: { root: string; dirs: string[]; bulk: boolean }) => void) => {
    fsChangedCb = cb;
    return () => {};
  }),
};
vi.mock("./ipc", () => ipc);
vi.mock("./bridges", () => ({
  highlightPaneAt: vi.fn(() => false),
  dropPathsAtPoint: vi.fn(() => false),
  clearPaneHighlight: vi.fn(),
}));

const { initFileTree } = await import("./filetree");

const ROOT = "D:\\ws";
let host: HTMLElement;
let opened: string[];

/** Rows currently painted, in visual order. */
const rowRels = () =>
  [...host.querySelectorAll<HTMLElement>(".tw-row")].map((e) => e.dataset.rel ?? "");
const rowFor = (rel: string) =>
  [...host.querySelectorAll<HTMLElement>(".tw-row")].find((e) => e.dataset.rel === rel)!;
const click = (rel: string, init: MouseEventInit = {}) =>
  rowFor(rel).dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
const key = (k: string, init: KeyboardEventInit = {}) =>
  host.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
const settle = () => new Promise((r) => setTimeout(r, 0));

function mount() {
  document.body.innerHTML =
    `<div id="cpTools"><button id="cpHidden"></button><button id="cpCollapse"></button></div>` +
    `<input id="cpFilter"><div id="fileTree"></div>`;
  host = document.getElementById("fileTree") as HTMLElement;
  opened = [];
  return initFileTree({ host, onOpenFile: (rel) => opened.push(rel) });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  fsChangedCb = null;
  fsTree = {
    "": [dir("src"), dir("docs"), file("README.md")],
    src: [dir("core"), file("main.ts")],
    "src\\core": [file("fs.rs")],
    docs: [file("guide.md")],
  };
  // happy-dom has no CSS.escape; the tree uses it for every row lookup.
  if (!globalThis.CSS?.escape) {
    (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s.replace(/\\/g, "\\\\") };
  }
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("file tree rendering", () => {
  it("lists the root, folders first, and expands on click", async () => {
    const tree = mount();
    tree.setRoot(ROOT);
    await vi.waitFor(() => expect(rowRels()).toEqual(["docs", "src", "README.md"]));

    click("src");
    await vi.waitFor(() => expect(rowRels()).toContain("src\\main.ts"));
    expect(rowRels()).toEqual(["docs", "src", "src\\core", "src\\main.ts", "README.md"]);
    // Depth drives the indent, so a nested row must carry its level.
    expect(rowFor("src\\core").style.getPropertyValue("--d")).toBe("1");
    expect(rowFor("src").classList.contains("open")).toBe(true);
  });

  it("opens a file on click instead of expanding", async () => {
    const tree = mount();
    tree.setRoot(ROOT);
    await vi.waitFor(() => expect(rowRels().length).toBe(3));
    click("README.md");
    expect(opened).toEqual(["README.md"]);
  });

  it("restores the folders that were open last time", async () => {
    localStorage.setItem(`maestro.tree.open:${ROOT}`, JSON.stringify(["src"]));
    const tree = mount();
    tree.setRoot(ROOT);
    await vi.waitFor(() => expect(rowRels()).toContain("src\\main.ts"));
  });
});

describe("multi-select and bulk delete", () => {
  it("ctrl+click adds to the selection and Delete trashes every selected path", async () => {
    const tree = mount();
    tree.setRoot(ROOT);
    await vi.waitFor(() => expect(rowRels().length).toBe(3));

    click("docs");
    click("README.md", { ctrlKey: true });
    expect([...host.querySelectorAll(".tw-row.sel")].map((e) => (e as HTMLElement).dataset.rel))
      .toEqual(["docs", "README.md"]);

    key("Delete");
    await vi.waitFor(() => expect(ipc.fsTrash).toHaveBeenCalledTimes(1));
    expect(ipc.fsTrash).toHaveBeenCalledWith(ROOT, ["docs", "README.md"]);
    // One confirmation for the whole batch, not one per item.
    expect(ipc.confirmDialog).toHaveBeenCalledTimes(1);
  });

  it("shift+click selects the range between anchor and target", async () => {
    const tree = mount();
    tree.setRoot(ROOT);
    await vi.waitFor(() => expect(rowRels().length).toBe(3));
    click("docs");
    click("README.md", { shiftKey: true });
    expect(host.querySelectorAll(".tw-row.sel").length).toBe(3);
  });

  it("deletes a whole folder without also trying to delete its children", async () => {
    const tree = mount();
    tree.setRoot(ROOT);
    await vi.waitFor(() => expect(rowRels().length).toBe(3));
    click("src");
    await vi.waitFor(() => expect(rowRels()).toContain("src\\main.ts"));
    // Selecting a folder *and* something inside it must delete the folder once
    // (clicking `src` above already selected it while expanding).
    click("src\\main.ts", { ctrlKey: true });
    click("src\\core", { ctrlKey: true });
    key("Delete");
    await vi.waitFor(() => expect(ipc.fsTrash).toHaveBeenCalled());
    expect(ipc.fsTrash).toHaveBeenCalledWith(ROOT, ["src"]);
  });
});

describe("keyboard navigation", () => {
  it("walks rows, opens folders with ArrowRight and opens files with Enter", async () => {
    const tree = mount();
    tree.setRoot(ROOT);
    await vi.waitFor(() => expect(rowRels().length).toBe(3));

    key("ArrowDown"); // docs
    expect(rowFor("docs").classList.contains("cur")).toBe(true);
    key("ArrowDown"); // src
    key("ArrowRight"); // expand src
    await vi.waitFor(() => expect(rowRels()).toContain("src\\main.ts"));
    key("ArrowLeft"); // collapse again
    await vi.waitFor(() => expect(rowRels()).not.toContain("src\\main.ts"));

    key("ArrowDown"); // README.md
    key("Enter");
    expect(opened).toEqual(["README.md"]);
  });
});

describe("live filesystem changes", () => {
  it("repaints only the directory the watcher reported", async () => {
    const tree = mount();
    tree.setRoot(ROOT);
    await vi.waitFor(() => expect(rowRels().length).toBe(3));
    expect(ipc.watchStart).toHaveBeenCalledWith(ROOT);

    // An agent writes a file into the root.
    fsTree[""] = [...fsTree[""], file("NOTES.md")];
    fsChangedCb?.({ root: ROOT, dirs: [""], bulk: false });
    await vi.waitFor(() => expect(rowRels()).toContain("NOTES.md"));
  });

  it("keeps expansion and selection across a refresh", async () => {
    const tree = mount();
    tree.setRoot(ROOT);
    await vi.waitFor(() => expect(rowRels().length).toBe(3));
    click("src");
    await vi.waitFor(() => expect(rowRels()).toContain("src\\main.ts"));
    click("src\\main.ts");

    fsTree.src = [...fsTree.src, file("extra.ts")];
    fsChangedCb?.({ root: ROOT, dirs: ["src"], bulk: false });
    await vi.waitFor(() => expect(rowRels()).toContain("src\\extra.ts"));
    expect(rowFor("src").classList.contains("open")).toBe(true);
    expect(rowFor("src\\main.ts").classList.contains("sel")).toBe(true);
  });

  it("ignores changes from another workspace's root", async () => {
    const tree = mount();
    tree.setRoot(ROOT);
    await vi.waitFor(() => expect(rowRels().length).toBe(3));
    ipc.fsReadDir.mockClear();
    fsChangedCb?.({ root: "D:\\other", dirs: [""], bulk: false });
    await settle();
    expect(ipc.fsReadDir).not.toHaveBeenCalled();
  });
});

describe("filter", () => {
  it("finds a file inside a folder that was never expanded", async () => {
    const tree = mount();
    tree.setRoot(ROOT);
    await vi.waitFor(() => expect(rowRels().length).toBe(3));

    const input = document.getElementById("cpFilter") as HTMLInputElement;
    input.value = "fs.";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(rowRels()).toEqual(["src\\core\\fs.rs"]), { timeout: 2000 });
    // Escape drops back to the normal tree.
    key("Escape");
    await vi.waitFor(() => expect(rowRels()).toEqual(["docs", "src", "README.md"]));
  });
});
