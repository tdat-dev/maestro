// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { confirmModal } from "./confirmmodal";

// The confirm dialog's markup, as index.html has it.
beforeEach(() => {
  document.body.innerHTML = `<button id="before">before</button>
  <div class="backdrop" id="confirmModal"><div class="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="cfTitle" aria-describedby="cfMsg">
    <span id="cfTitle"></span><p id="cfMsg"></p>
    <div id="cfInputRow" hidden><input id="cfInput"></div>
    <label id="cfDontaskRow" hidden><input type="checkbox" id="cfDontask"></label>
    <button id="cfCancel">Cancel</button><button class="btn" id="cfOk">Confirm</button>
  </div></div>`;
});

const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

describe("confirmModal", () => {
  it("starts a destructive question on Cancel, and Enter there is not a yes", async () => {
    document.getElementById("before")!.focus();
    const answer = confirmModal({ title: "Remove Ana?", message: "It stops.", okLabel: "Remove", danger: true });
    const cancel = document.getElementById("cfCancel")!;
    expect(document.activeElement).toBe(cancel);
    expect(document.getElementById("cfOk")!.classList.contains("danger")).toBe(true);
    key(cancel, "Enter"); // the button itself handles Enter (as a click); the dialog doesn't confirm
    expect(document.getElementById("confirmModal")!.classList.contains("open")).toBe(true);
    cancel.click();
    expect((await answer).ok).toBe(false);
    // focus goes back where it was
    expect(document.activeElement).toBe(document.getElementById("before"));
  });

  it("confirms with Enter in its text field, and paints a harmless question white", async () => {
    const answer = confirmModal({ title: "Rename agent", message: "New name?", okLabel: "Rename", input: { value: "Ana" } });
    expect(document.getElementById("cfOk")!.classList.contains("danger")).toBe(false);
    const input = document.getElementById("cfInput") as HTMLInputElement;
    input.value = "Zed";
    key(input, "Enter");
    expect(await answer).toEqual({ ok: true, dontAsk: false, value: "Zed" });
  });

  it("closes on Escape as a no", async () => {
    const answer = confirmModal({ title: "Close project", message: "Stops its agents.", danger: true });
    key(document.getElementById("cfCancel")!, "Escape");
    expect((await answer).ok).toBe(false);
  });
});
