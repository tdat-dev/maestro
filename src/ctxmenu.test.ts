import { afterEach, describe, expect, it, vi } from "vitest";
import { blockNativeMenu, closeMenu, editableAt, editMenu, menuShown, openMenu } from "./ctxmenu";

describe("ctxmenu", () => {
  afterEach(() => { closeMenu(false); document.body.innerHTML = ""; });

  it("finds the text field under a right-click, never in a terminal", () => {
    document.body.innerHTML = `<div id="side"><button id="b">x</button></div><input id="i"><input id="cb" type="checkbox"><textarea id="t"></textarea>
      <span id="ce" contenteditable="true">n</span><div class="xterm"><textarea id="xt"></textarea></div>`;
    const $ = (id: string) => document.getElementById(id);
    expect(editableAt($("side"))).toBeNull();
    expect(editableAt($("b"))).toBeNull();
    expect(editableAt($("cb"))).toBeNull();
    expect(editableAt($("xt"))).toBeNull();
    expect(editableAt($("i"))).toBe($("i"));
    expect(editableAt($("t"))).toBe($("t"));
    expect(editableAt($("ce"))).toBe($("ce"));
  });

  it("offers Cut and Copy only with a selection, and pastes into the field", async () => {
    document.body.innerHTML = `<input id="i" value="hello world">`;
    const i = document.getElementById("i") as HTMLInputElement;
    const on = (m: ReturnType<typeof editMenu>) => m.filter((x) => !x.disabled).map((x) => x.label);
    i.setSelectionRange(0, 0);
    expect(on(editMenu(i))).toEqual(["Paste", "Select all"]);
    i.setSelectionRange(0, 5);
    expect(on(editMenu(i))).toEqual(["Cut", "Copy", "Paste", "Select all"]);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "HEY", writeText: async () => {} } });
    editMenu(i).find((x) => x.label === "Paste")!.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(i.value).toBe("HEY world");
  });

  it("never shows the page menu, and opens the edit menu on a field", () => {
    blockNativeMenu(false);
    document.body.innerHTML = `<div id="side"></div><input id="i">`;
    const fire = (id: string) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.getElementById(id)!.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire("side")).toBe(true);
    expect(menuShown()).toBe(false);
    expect(fire("i")).toBe(true);
    expect(menuShown()).toBe(true);
  });

  it("runs the picked item and skips disabled ones from the keyboard", () => {
    const run = vi.fn();
    const off = vi.fn();
    openMenu(10, 10, [{ label: "Open", run }, { label: "Stop", run: off, disabled: true }, { label: "Remove", run, danger: true }]);
    const menu = document.querySelector<HTMLElement>(".cm-menu")!;
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(off).not.toHaveBeenCalled();
    expect(menuShown()).toBe(false);
  });
});
