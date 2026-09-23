import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { close, enhanceSelect, enhanceSelects, menuOpen } from "./selectmenu";

function mk(): HTMLSelectElement {
  document.body.innerHTML = `<label><span class="ia-sr">Agent</span><select id="s">
    <option value="a">Alpha</option>
    <option value="b" disabled data-note="Not installed">Bravo</option>
    <option value="c" data-sub="~/code/c" data-sep>Charlie</option>
  </select></label>`;
  return document.getElementById("s") as HTMLSelectElement;
}

const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
const pop = () => document.querySelector<HTMLElement>(".sm-pop");

describe("selectmenu", () => {
  let sel: HTMLSelectElement;
  let btn: HTMLButtonElement;
  beforeEach(() => { sel = mk(); btn = enhanceSelect(sel); });
  afterEach(() => { close(false); document.body.innerHTML = ""; });

  it("hides the select and shows its choice on a named button", () => {
    expect(sel.classList.contains("sm-native")).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("Agent");
    expect(btn.querySelector(".sm-val")?.textContent).toBe("Alpha");
    expect(enhanceSelect(sel)).toBe(btn);
  });

  it("follows values set in code", () => {
    sel.value = "c";
    expect(btn.querySelector(".sm-val")?.textContent).toBe("Charlie");
    sel.selectedIndex = 0;
    expect(btn.querySelector(".sm-val")?.textContent).toBe("Alpha");
  });

  it("lists options with the path, the divider and a note on disabled rows", () => {
    btn.click();
    expect(menuOpen()).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const opts = pop()!.querySelectorAll(".sm-opt");
    expect(opts).toHaveLength(3);
    expect(opts[0].getAttribute("aria-selected")).toBe("true");
    expect(opts[1].getAttribute("aria-disabled")).toBe("true");
    expect(opts[1].querySelector(".sm-note")?.textContent).toBe("Not installed");
    expect(opts[2].querySelector(".sm-sub")?.textContent).toBe("~/code/c");
    expect(pop()!.querySelectorAll(".sm-sep")).toHaveLength(1);
  });

  it("picks with the keyboard, skipping disabled rows, and fires change", () => {
    const onChange = vi.fn();
    sel.addEventListener("change", onChange);
    key(btn, "ArrowDown");
    key(pop()!, "ArrowDown");
    key(pop()!, "Enter");
    expect(sel.value).toBe("c");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(menuOpen()).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it("ignores clicks on disabled rows and closes on Escape without a change", () => {
    const onChange = vi.fn();
    sel.addEventListener("change", onChange);
    btn.click();
    (pop()!.querySelectorAll(".sm-opt")[1] as HTMLElement).click();
    expect(sel.value).toBe("a");
    expect(menuOpen()).toBe(true);
    key(pop()!, "Escape");
    expect(menuOpen()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes when you press outside", () => {
    btn.click();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(menuOpen()).toBe(false);
  });

  it("enhances every select under a root once", () => {
    document.body.insertAdjacentHTML("beforeend", `<div id="r"><select><option>x</option></select><select data-native><option>y</option></select></div>`);
    enhanceSelects(document.getElementById("r")!);
    enhanceSelects(document.getElementById("r")!);
    expect(document.querySelectorAll("#r .sm-btn")).toHaveLength(1);
  });
});
