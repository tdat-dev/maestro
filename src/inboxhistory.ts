// History drawer for the Agent Inbox: what one agent did, oldest at the top,
// grouped by day, so "what happened while I was away?" has an answer that is
// not scrolling back through a terminal.

import { historyOf, type HistoryEvent } from "./tasks";
import type { Pane } from "./panetypes";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** "Today", "Yesterday", or "Mon 21 Sep". */
export function dayLabel(at: number, now: number = Date.now()): string {
  const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((day(now) - day(at)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Events grouped by day, in order. */
export function byDay(events: HistoryEvent[], now: number = Date.now()): Array<{ day: string; events: HistoryEvent[] }> {
  const out: Array<{ day: string; events: HistoryEvent[] }> = [];
  for (const e of events) {
    const day = dayLabel(e.at, now);
    if (out[out.length - 1]?.day !== day) out.push({ day, events: [] });
    out[out.length - 1].events.push(e);
  }
  return out;
}

export function createHistoryDrawer(host: HTMLElement, onClose: () => void) {
  let el: HTMLElement | null = null;
  let current: Pane | null = null;
  let drawn = -1;

  function close(): void {
    el?.remove();
    el = null;
    const was = current;
    current = null;
    drawn = -1;
    onClose();
    was?.term.focus();
  }

  /** Redraw when new events arrived (cheap to call every tick). */
  function refresh(): void {
    if (!el || !current) return;
    const events = historyOf(current.id);
    if (events.length === drawn) return;
    drawn = events.length;
    const body = el.querySelector<HTMLElement>(".ih-body")!;
    body.innerHTML = events.length
      ? byDay(events).map((g) => `<section class="ih-day"><h3>${esc(g.day)}</h3><ol>${g.events.map((e) =>
          `<li class="ih-ev k-${e.kind}"><time>${clock(e.at)}</time><i aria-hidden="true"></i><span>${esc(e.text)}</span></li>`).join("")}</ol></section>`).join("")
      : `<p class="ih-empty">Nothing yet. Questions, answers and finished work show up here as ${esc(current.spec.name)} goes.</p>`;
    body.scrollTop = body.scrollHeight;
  }

  function open(pane: Pane): void {
    el?.remove();
    current = pane;
    drawn = -1;
    el = document.createElement("aside");
    el.className = "inbox-review inbox-history";
    el.setAttribute("aria-label", `${pane.spec.name}'s history`);
    el.innerHTML = `
      <header class="ir-head">
        <div class="ir-title"><b>${esc(pane.spec.name)}'s history</b><span class="ir-where">Kept while Maestro is open</span></div>
        <button class="ir-close" type="button" aria-label="Close history">Close</button>
      </header>
      <div class="ih-body" tabindex="0"></div>`;
    host.appendChild(el);
    el.querySelector(".ir-close")!.addEventListener("click", close);
    el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
    refresh();
  }

  return {
    open,
    close,
    refresh,
    get paneId(): string | null { return current?.id ?? null; },
  };
}
