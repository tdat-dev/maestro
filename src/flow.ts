/* Flow — the running record of every hand-off in the fleet: who sent what to
 * whom, in order, with the text kept. The canvas arc and the toast both vanish
 * after 2.6s, which is enough to notice that something happened and useless for
 * reading what the director actually told everyone.
 *
 * Deliberately cheap. There is no watcher, no poll, no timer and no IPC of its
 * own: the one call site in bridges.ts that already draws the arc records here
 * too. With the panel closed a message costs an array push and one badge
 * number — rows are only built while you are looking at them, and the buffer is
 * hard-capped so a long session can't grow it.
 */

import { revealPane } from "./agentbridge";

/** Messages kept in memory. Older ones fall off the front. */
export const FLOW_MAX = 200;
/** Row text is clamped to two lines by CSS; this caps what we store per row. */
export const FLOW_TEXT_MAX = 2000;

export interface FlowTarget {
  wsId: string;
  paneId: string;
  name: string;
}

export interface FlowMsg {
  id: number;
  ts: number;
  /** Sender's agent name; null when the outbox line didn't identify one. */
  from: string | null;
  /** Addressed recipient, or null for a broadcast to everyone running. */
  to: string | null;
  /** Panes the message was actually typed into. */
  targets: FlowTarget[];
  /** Sender's pane colour, for the avatar. */
  color?: string;
  text: string;
}

export type FlowInput = Omit<FlowMsg, "id" | "ts"> & { ts?: number };

const buf: FlowMsg[] = [];
const listeners = new Set<(m: FlowMsg) => void>();
let seq = 0;

/** Store `s` at a sane length — a runaway paste shouldn't sit in memory 200×. */
export function clampText(s: string, max = FLOW_TEXT_MAX): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Who a row says it went to: the addressed name, or the broadcast label. */
export function toLabel(m: Pick<FlowMsg, "to" | "targets">): string {
  if (m.to) return m.to;
  if (m.targets.length === 1) return m.targets[0].name;
  return m.targets.length ? `everyone (${m.targets.length})` : "everyone";
}

/** Record one hand-off and notify whoever is listening. Never throws — the
 *  caller is mid-delivery and must not care whether we logged it. */
export function pushFlow(m: FlowInput): FlowMsg {
  seq += 1;
  const msg: FlowMsg = {
    id: seq,
    ts: m.ts ?? Date.now(),
    from: m.from,
    to: m.to,
    targets: m.targets,
    color: m.color,
    text: clampText(m.text),
  };
  buf.push(msg);
  if (buf.length > FLOW_MAX) buf.splice(0, buf.length - FLOW_MAX);
  for (const fn of listeners) {
    try {
      fn(msg);
    } catch {
      /* a broken view must not break delivery */
    }
  }
  return msg;
}

export function flowLog(): readonly FlowMsg[] {
  return buf;
}

export function onFlow(fn: (m: FlowMsg) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Drop everything (the panel's Clear button, and test isolation). */
export function clearFlow(): void {
  buf.length = 0;
}

/* ---------------- the dock panel ---------------- */

const pad = (n: number) => (n < 10 ? "0" : "") + n;

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Distance from the bottom (px) still treated as "pinned to the newest". */
const STICK_PX = 24;

export function createFlow() {
  let root: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let empty: HTMLElement | null = null;
  let badge: HTMLElement | null = null;
  let open = false;
  let unread = 0;
  // Highest id already turned into a row, so reopening only appends the gap.
  let renderedId = 0;

  function rowEl(m: FlowMsg): HTMLElement {
    const row = document.createElement("div");
    row.className = "flow-row";

    const head = document.createElement("button");
    head.className = "flow-head";
    head.title = m.targets.length ? "Jump to this agent" : "";

    const av = document.createElement("span");
    av.className = "flow-av";
    av.textContent = (m.from ?? "?").slice(0, 1).toUpperCase();
    if (m.color) av.style.background = m.color;

    const who = document.createElement("span");
    who.className = "flow-who";
    const from = document.createElement("b");
    from.textContent = m.from ?? "someone";
    const arw = document.createElement("span");
    arw.className = "flow-arw";
    arw.textContent = "→";
    const to = document.createElement("span");
    to.className = "flow-to";
    to.textContent = toLabel(m);
    who.append(from, arw, to);

    const time = document.createElement("time");
    time.className = "flow-time";
    time.textContent = fmtTime(m.ts);

    head.append(av, who, time);
    head.addEventListener("click", () => {
      const t = m.targets[0];
      if (t) revealPane(t.wsId, t.paneId);
    });

    const body = document.createElement("button");
    body.className = "flow-text";
    body.textContent = m.text;
    body.title = "Show the full message";
    body.addEventListener("click", () => body.classList.toggle("full"));

    row.append(head, body);
    return row;
  }

  function atBottom(): boolean {
    if (!root) return true;
    return root.scrollHeight - root.scrollTop - root.clientHeight < STICK_PX;
  }

  /** Append every message newer than what's on screen, keeping the DOM capped
   *  at the buffer size and the view pinned unless you've scrolled up. */
  function drain(): void {
    if (!list || !open) return;
    const stick = atBottom();
    for (const m of buf) {
      if (m.id <= renderedId) continue;
      list.appendChild(rowEl(m));
      renderedId = m.id;
    }
    while (list.childElementCount > FLOW_MAX) list.firstElementChild?.remove();
    if (empty) empty.hidden = list.childElementCount > 0;
    if (stick && root) root.scrollTop = root.scrollHeight;
  }

  function refreshBadge(): void {
    if (!badge) return;
    badge.textContent = unread > 99 ? "99+" : String(unread);
    badge.hidden = unread === 0;
  }

  return {
    mount(body: HTMLElement, actions: HTMLElement) {
      root = document.createElement("div");
      root.className = "flow-root";

      empty = document.createElement("div");
      empty.className = "flow-empty";
      empty.innerHTML = `<p>No hand-offs yet.<br>When the Director sends work to an agent, it shows up here.</p>`;

      list = document.createElement("div");
      list.className = "flow-list";

      root.append(empty, list);
      body.appendChild(root);

      const clear = document.createElement("button");
      clear.className = "dock-act";
      clear.type = "button";
      clear.title = "Clear the flow";
      clear.setAttribute("aria-label", "Clear the flow");
      clear.innerHTML =
        `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ` +
        `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>`;
      clear.addEventListener("click", () => {
        clearFlow();
        list?.replaceChildren();
        renderedId = seq;
        if (empty) empty.hidden = false;
      });
      actions.appendChild(clear);

      // The only subscription in the module. Closed panel ⇒ count and stop.
      onFlow(() => {
        if (open) drain();
        else {
          unread += 1;
          refreshBadge();
        }
      });
    },
    show() {
      open = true;
      unread = 0;
      refreshBadge();
      drain();
    },
    hide() {
      open = false;
    },
    attachBadge(button: HTMLElement) {
      badge = document.createElement("span");
      badge.className = "fleet-badge";
      badge.hidden = true;
      button.appendChild(badge);
    },
  };
}
