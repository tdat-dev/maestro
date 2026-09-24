// Review drawer for the Agent Inbox: what an agent changed, and what to do
// with it. The diff, commit, discard and merge are the existing diff view
// (diffview.ts) pointed at the agent's own worktree; the drawer adds "Send
// back", which types your feedback straight into the agent's terminal.

import { createDiffView } from "./diffview";
import { focusAgent } from "./chatview";
import { answerText } from "./tasks";
import type { Pane } from "./panetypes";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The folder whose changes belong to this agent: its worktree, else where it runs. */
export function reviewDir(pane: Pane): string | null {
  return pane.spec.worktree || pane.spec.cwd || null;
}

export function createReviewDrawer(host: HTMLElement, onClose: () => void) {
  let el: HTMLElement | null = null;
  let current: Pane | null = null;

  function close(): void {
    el?.remove();
    el = null;
    const was = current;
    current = null;
    onClose();
    if (was) focusAgent(was);
  }

  function open(pane: Pane): void {
    el?.remove();
    current = pane;
    const name = pane.spec.name;
    const where = pane.spec.branch || pane.spec.worktree || pane.spec.cwd || "";
    el = document.createElement("aside");
    el.className = "inbox-review";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", `${name}'s changes`);
    el.innerHTML = `
      <header class="ir-head">
        <div class="ir-title"><b>${esc(name)}'s changes</b>${where ? `<span class="ir-where">${esc(where)}</span>` : ""}</div>
        <span class="ir-acts"></span>
        <button class="ir-close" type="button" aria-label="Close changes" title="Close (Esc)">Close</button>
      </header>
      <div class="ir-body"></div>
      <form class="ir-back">
        <label class="ia-sr" for="irBack">Send ${esc(name)} back with what should change</label>
        <input id="irBack" autocomplete="off" placeholder="Send back to ${esc(name)}: what should change?">
        <button type="submit">Send back</button>
      </form>`;
    host.appendChild(el);
    const view = createDiffView();
    view.mount(el.querySelector<HTMLElement>(".ir-body")!, el.querySelector<HTMLElement>(".ir-acts")!);
    view.setContext({ key: `inbox:${pane.id}`, dir: reviewDir(pane) });
    view.show();
    el.querySelector(".ir-close")!.addEventListener("click", close);
    // The keyboard comes along, so Esc closes it straight away.
    el.querySelector<HTMLElement>(".ir-close")!.focus({ preventScroll: true });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    });
    el.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = el?.querySelector<HTMLInputElement>("#irBack");
      const text = input?.value.trim();
      if (!text || !current) return;
      const target = current;
      void answerText(target.id, text);
      close();
      focusAgent(target);
    });
  }

  return {
    open,
    close,
    /** The agent being reviewed, if the drawer is open. */
    get paneId(): string | null { return current?.id ?? null; },
  };
}
