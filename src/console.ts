/* Fleet Console — the command bar grown into a conversation. The composer stays
 * pinned to the bottom; focusing it (or tapping the grip) slides a thread up out
 * of it showing what you broadcast and what the Director handed to which agent,
 * as chat bubbles. Read-only over two things it already owns elsewhere: the Flow
 * ring buffer (who sent what to whom) and the fleet snapshot (who's online).
 *
 * Cheap by construction: no timer while closed, one Flow subscription, bubbles
 * built only while the thread is open. The members strip ticks only while open. */

import { flowLog, onFlow, toLabel, fmtTime, type FlowMsg } from "./flow";
import { fleetSnapshotNow, revealPane } from "./agentbridge";
import { paneStatus } from "./fleet";

const enc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The user's own sender name in the thread; kept in one place so broadcast.ts
 *  and the bubble renderer agree on which side a message sits. */
export const ME = "You";

/** True when this row is something you sent (right-aligned in the thread). */
export function isMine(m: Pick<FlowMsg, "from">): boolean {
  return m.from === ME;
}

let el = {
  console: null as HTMLElement | null,
  thread: null as HTMLElement | null,
  log: null as HTMLElement | null,
  empty: null as HTMLElement | null,
  grip: null as HTMLElement | null,
  collapse: null as HTMLElement | null,
  members: null as HTMLElement | null,
  unread: null as HTMLElement | null,
  input: null as HTMLElement | null,
};
let isOpen = false;
let unread = 0;
let membersTimer: number | null = null;

function bubble(m: FlowMsg): HTMLElement {
  const mine = isMine(m);
  const row = document.createElement("div");
  row.className = "fcb" + (mine ? " me" : " them");

  if (!mine) {
    const av = document.createElement("span");
    av.className = "fcb-av";
    av.textContent = (m.from ?? "?").slice(0, 1).toUpperCase();
    if (m.color) av.style.background = m.color;
    row.appendChild(av);
  }

  const col = document.createElement("div");
  col.className = "fcb-col";

  const meta = document.createElement("div");
  meta.className = "fcb-meta";
  // "You → Ana", "Dot → everyone (3)" — the arrow makes the hand-off legible.
  meta.innerHTML =
    `<span class="fcb-from">${enc(m.from ?? "someone")}</span>` +
    `<span class="fcb-arw">→</span>` +
    `<span class="fcb-to">${enc(toLabel(m))}</span>` +
    `<time class="fcb-time">${fmtTime(m.ts)}</time>`;

  const body = document.createElement("button");
  body.className = "fcb-body";
  body.type = "button";
  body.textContent = m.text;
  body.title = m.targets.length ? "Jump to this agent" : "Show the full message";
  body.addEventListener("click", () => {
    const t = m.targets[0];
    if (t) revealPane(t.wsId, t.paneId);
    else body.classList.toggle("full");
  });

  col.append(meta, body);
  row.appendChild(col);
  return row;
}

function scrollBottom(): void {
  if (el.log) el.log.scrollTop = el.log.scrollHeight;
}

/** Rebuild the whole thread from the buffer (buffer is hard-capped at 200). */
function renderAll(): void {
  if (!el.log || !el.empty) return;
  el.log.replaceChildren();
  const msgs = flowLog();
  for (const m of msgs) el.log.appendChild(bubble(m));
  el.empty.hidden = msgs.length > 0;
  scrollBottom();
}

function renderMembers(): void {
  if (!el.members) return;
  const rows = fleetSnapshotNow();
  const now = Date.now();
  el.members.replaceChildren();
  const needs = rows.filter((r) => paneStatus(r, now) === "needs").length;
  for (const r of rows.slice(0, 7)) {
    const st = paneStatus(r, now); // needs | active | idle | stopped
    const dot = document.createElement("span");
    dot.className = "fc-mem st-" + st;
    dot.style.background = r.color;
    dot.title = `${r.name} — ${st === "active" ? "running" : st === "needs" ? "needs you" : st}`;
    el.members.appendChild(dot);
  }
  if (rows.length > 7) {
    const more = document.createElement("span");
    more.className = "fc-mem-more";
    more.textContent = `+${rows.length - 7}`;
    el.members.appendChild(more);
  }
  if (needs) {
    const pill = document.createElement("span");
    pill.className = "fc-mem-needs";
    pill.textContent = `${needs} need${needs === 1 ? "s" : ""} you`;
    el.members.appendChild(pill);
  }
}

function renderUnread(): void {
  if (!el.unread) return;
  el.unread.textContent = unread > 99 ? "99+" : String(unread);
  el.unread.hidden = unread === 0;
}

function setOpen(on: boolean): void {
  if (on === isOpen || !el.console || !el.thread || !el.grip) return;
  isOpen = on;
  el.console.dataset.open = String(on);
  el.thread.hidden = !on;
  el.grip.hidden = on; // the grip invites opening; the thread has its own collapse
  if (on) {
    unread = 0;
    renderUnread();
    renderAll();
    renderMembers();
    if (membersTimer === null) membersTimer = window.setInterval(renderMembers, 2500);
  } else if (membersTimer !== null) {
    window.clearInterval(membersTimer);
    membersTimer = null;
  }
}

export function openConsole(): void {
  setOpen(true);
}
export function closeConsole(): void {
  setOpen(false);
}

/** Empty the on-screen thread (the flow buffer is cleared by the caller). */
export function clearConsole(): void {
  el.log?.replaceChildren();
  if (el.empty) el.empty.hidden = false;
}

/** Wire the console once at startup. Safe no-op if the markup isn't present. */
export function initConsole(): void {
  el = {
    console: document.getElementById("fleetConsole"),
    thread: document.getElementById("fcThread"),
    log: document.getElementById("fcLog"),
    empty: document.getElementById("fcEmpty"),
    grip: document.getElementById("fcHistory"),
    collapse: document.getElementById("fcCollapse"),
    members: document.getElementById("fcMembers"),
    unread: document.getElementById("fcUnread"),
    input: document.getElementById("bcastInput"),
  };
  if (!el.console) return;

  el.grip?.addEventListener("click", () => openConsole());
  el.collapse?.addEventListener("click", () => closeConsole());
  // Typing is talking: focusing the composer slides the conversation up.
  el.input?.addEventListener("focus", () => openConsole());
  // Escape collapses (but let the @mention/target popovers eat it first — they
  // stopPropagation on their own Escape, so this only fires when none is open).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) closeConsole();
  });
  // Click outside the whole console closes it.
  document.addEventListener("mousedown", (e) => {
    if (!isOpen || !el.console) return;
    if (!el.console.contains(e.target as Node)) closeConsole();
  });

  // The one subscription: append live while open, count while closed.
  onFlow((m) => {
    if (isOpen) {
      if (el.empty) el.empty.hidden = true;
      const pinned = el.log
        ? el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 40
        : true;
      el.log?.appendChild(bubble(m));
      while (el.log && el.log.childElementCount > 200) el.log.firstElementChild?.remove();
      if (pinned) scrollBottom();
      renderMembers();
    } else {
      unread += 1;
      renderUnread();
    }
  });
}
