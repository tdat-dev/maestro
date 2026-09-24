import { afterEach, describe, expect, it, vi } from "vitest";
import { blockNativeMenu, closeMenu, menuShown, nativeMenuAllowed, openMenu } from "./ctxmenu";

describe("ctxmenu", () => {
  afterEach(() => { closeMenu(false); document.body.innerHTML = ""; });

  it("keeps the browser menu only in text fields and terminals", () => {
    document.body.innerHTML = `<div id="side"><button id="b">x</button></div><input id="i"><textarea id="t"></textarea>
      <span id="ce" contenteditable="true">n</span><div class="xterm"><canvas id="c"></canvas></div>`;
    const $ = (id: string) => document.getElementById(id);
    expect(nativeMenuAllowed($("side"), false, false)).toBe(false);
    expect(nativeMenuAllowed($("b"), false, false)).toBe(false);
    expect(nativeMenuAllowed($("i"), false, false)).toBe(true);
    expect(nativeMenuAllowed($("t"), false, false)).toBe(true);
    expect(nativeMenuAllowed($("ce"), false, false)).toBe(true);
    expect(nativeMenuAllowed($("c"), false, false)).toBe(true);
    // Shift+right-click still reaches Inspect while developing, never in a build
    expect(nativeMenuAllowed($("side"), true, true)).toBe(true);
    expect(nativeMenuAllowed($("side"), true, false)).toBe(false);
  });

  it("stops the page menu on empty space", () => {
    blockNativeMenu(false);
    document.body.innerHTML = `<div id="side"></div><input id="i">`;
    const fire = (id: string) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.getElementById(id)!.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire("side")).toBe(true);
    expect(fire("i")).toBe(false);
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
