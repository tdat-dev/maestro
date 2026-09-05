// The broadcast console: type once, signal the whole tab. A message with no
// @mention goes to every running agent; an "@name …" line routes to just that
// agent. Handles @mention routing + the name-picker autocomplete and input
// history. Split out of main.ts; the active workspace is read through an
// injected getter so this module never imports back into main (no cycle).

import { sendMessage } from "./ipc";
import { activeMention, matchNames, splitMentions } from "./mention";
import { type Pane, type Workspace } from "./panetypes";

let getWs: () => Workspace | null = () => null;
export function configureBroadcast(deps: { getActiveWs: () => Workspace | null }): void {
  getWs = deps.getActiveWs;
}

const bcast = document.getElementById("bcast") as HTMLElement;
const bcastInput = document.getElementById("bcastInput") as HTMLInputElement;
const bcastSend = document.getElementById("bcastSend") as HTMLButtonElement;
const bcastEmitter = document.getElementById("bcastEmitter");
const bcastAc = document.getElementById("bcastAc") as HTMLElement;
const bcastTarget = document.getElementById("bcastTarget") as HTMLButtonElement;
const bcastTargetIc = document.getElementById("bcastTargetIc") as HTMLElement;
const bcastTargetNm = document.getElementById("bcastTargetNm") as HTMLElement;
const bcastTargetMenu = document.getElementById("bcastTargetMenu") as HTMLElement;

// Who a no-@mention message goes to: null = the whole running fleet (broadcast),
// or a specific pane id picked from the target chip. @mentions in the text still
// override this per segment. Reset to Fleet when that agent is gone.
let targetId: string | null = null;

const BROADCAST_IC =
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>`;

function activeRunning(): Pane[] {
  const ws = getWs();
  return ws ? [...ws.panes.values()].filter((p) => p.running) : [];
}

/** The pane the chip currently points at (null = Fleet, or gone). */
function targetPane(): Pane | null {
  if (!targetId) return null;
  return activeAgents().find((p) => p.id === targetId) ?? null;
}
/** Who a no-@mention message reaches: the chosen agent (if alive) or the fleet. */
function defaultTargets(): Pane[] {
  const t = targetPane();
  if (t) return t.running ? [t] : [];
  return activeRunning();
}
// Every agent in the active workspace, running or idle. The @mention picker and
// name-resolution use this (so a parked/finished agent still autocompletes and
// resolves), while a no-mention broadcast still only reaches the running ones.
function activeAgents(): Pane[] {
  const ws = getWs();
  return ws ? [...ws.panes.values()] : [];
}

export function updateBcast(): void {
  // The target chip may point at an agent that was just killed/renamed away —
  // fall back to Fleet so the composer never addresses a ghost.
  if (targetId && !targetPane()) targetId = null;
  renderTargetChip();

  const allAgents = activeAgents();
  // Default: the chip's target (Fleet = whole running fleet). An "@name …" line
  // narrows it to that one (matched against every agent, idle recognised too).
  let targets = defaultTargets();

  const text = bcastInput?.value || "";
  const sorted = [...allAgents].sort((a, b) => b.spec.name.length - a.spec.name.length);
  for (const p of sorted) {
    const escapedName = p.spec.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^@?${escapedName}(?:[-\\s]?([1-9][0-9]*))?[:,]?(?:\\s+|$)`, "i");
    const match = text.match(regex);
    if (match) {
      const exactMatches = allAgents.filter((agent) => agent.spec.name.toLowerCase() === p.spec.name.toLowerCase());
      if (match[1]) {
        const idx = parseInt(match[1], 10) - 1;
        targets = idx >= 0 && idx < exactMatches.length ? [exactMatches[idx]] : []; // out-of-bounds index
      } else {
        targets = exactMatches;
      }
      break;
    }
  }

  const n = targets.length;
  bcastSend.disabled = n === 0 || bcastInput.value.length === 0;
  bcastEmitter?.classList.toggle("live", n > 0);
}

function flashPane(p: Pane): void {
  p.el.classList.remove("recv");
  void p.el.offsetWidth; // restart the animation
  p.el.classList.add("recv");
  setTimeout(() => p.el.classList.remove("recv"), 520);
}

const bcastHistory: string[] = [];
let bcastHistIdx = 0; // points one past the newest entry

function broadcast(): void {
  const originalText = bcastInput.value;
  const allRunning = activeRunning();
  // Recognise every agent's name (even idle ones) so "@idle …" is parsed as a
  // mention that reaches nobody, rather than being sent verbatim to the fleet.
  const names = activeAgents().map((p) => p.spec.name);
  // A line can name several agents: "@Ana run tests @Bob deploy". Text before
  // any mention (or a line with no mention) goes to the whole running fleet.
  const segs = splitMentions(originalText, names);
  const defaults = defaultTargets();
  let sentAny = false;
  for (const seg of segs) {
    if (!seg.body) continue;
    const targets = seg.name
      ? allRunning.filter((p) => p.spec.name.toLowerCase() === seg.name!.toLowerCase())
      : defaults; // no @mention → the chip's target (Fleet by default)
    for (const p of targets) {
      void sendMessage(p.id, seg.body).catch(() => {});
      flashPane(p);
      sentAny = true;
    }
  }
  if (!sentAny) return;
  if (bcastHistory[bcastHistory.length - 1] !== originalText) bcastHistory.push(originalText);
  bcastHistIdx = bcastHistory.length;
  bcastInput.value = "";
  updateBcast();
  bcastInput.focus();
  bcast.classList.remove("sent");
  void bcast.offsetWidth; // restart the ripple
  bcast.classList.add("sent");
  setTimeout(() => bcast.classList.remove("sent"), 560);
}

// --- @mention autocomplete: a name picker while typing "@" ---
let acItems: string[] = [];
let acSel = 0;
function closeAc(): void {
  bcastAc.classList.add("hidden");
  acItems = [];
}
function nameColor(name: string): string {
  return activeAgents().find((p) => p.spec.name === name)?.color ?? "var(--muted)";
}
function nameMeta(name: string): string {
  const p = activeAgents().find((p) => p.spec.name === name);
  if (!p) return "";
  return `${p.spec.badge} · ${p.running ? "running" : "idle"}`;
}
function updateAc(): void {
  const q = activeMention(bcastInput.value, bcastInput.selectionStart ?? bcastInput.value.length);
  if (q === null) return closeAc();
  const names = [...new Set(activeAgents().map((p) => p.spec.name))];
  acItems = matchNames(q, names);
  if (!acItems.length) return closeAc();
  acSel = 0;
  bcastAc.replaceChildren();
  const header = document.createElement("div");
  header.className = "bcast-ac-h";
  header.textContent = "Mention an agent";
  bcastAc.appendChild(header);
  acItems.forEach((n, i) => {
    const row = document.createElement("button");
    row.className = "bcast-ac-item" + (i === acSel ? " sel" : "");
    row.innerHTML = `<span class="dot" style="background:${nameColor(n)}"></span>${n}<span class="r">${nameMeta(n)}</span>`;
    row.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      pickAc(n);
    });
    bcastAc.appendChild(row);
  });
  bcastAc.classList.remove("hidden");
}
function moveAc(delta: number): void {
  if (!acItems.length) return;
  acSel = (acSel + delta + acItems.length) % acItems.length;
  [...bcastAc.querySelectorAll(".bcast-ac-item")].forEach((c, i) => c.classList.toggle("sel", i === acSel));
}
function pickAc(name: string): void {
  const caret = bcastInput.selectionStart ?? bcastInput.value.length;
  const before = bcastInput.value.slice(0, caret).replace(/@\w*$/, "@" + name + " ");
  const after = bcastInput.value.slice(caret);
  bcastInput.value = before + after;
  bcastInput.setSelectionRange(before.length, before.length);
  closeAc();
  bcastInput.focus();
  updateBcast();
}

// --- target chip: pick who a plain (no-@mention) message goes to ---
function renderTargetChip(): void {
  if (!bcastTarget) return;
  const t = targetPane();
  if (t) {
    bcastTarget.classList.add("targeted");
    const letter = (t.spec.name.trim()[0] ?? "?").toUpperCase();
    bcastTargetIc.innerHTML = `<span class="cb-target-av" style="background:${t.color}">${letter}</span>`;
    bcastTargetNm.textContent = t.spec.name;
    bcastInput.placeholder = `Message ${t.spec.name}…`;
  } else {
    bcastTarget.classList.remove("targeted");
    bcastTargetIc.innerHTML = BROADCAST_IC;
    bcastTargetNm.textContent = "Fleet";
    bcastInput.placeholder = "Message the fleet…";
  }
}

let targetMenuOpen = false;
function closeTargetMenu(): void {
  bcastTargetMenu.classList.add("hidden");
  bcastTarget.setAttribute("aria-expanded", "false");
  targetMenuOpen = false;
}
function setTarget(id: string | null): void {
  targetId = id;
  closeTargetMenu();
  renderTargetChip();
  updateBcast();
  bcastInput.focus();
}
function openTargetMenu(): void {
  const agents = activeAgents();
  bcastTargetMenu.replaceChildren();
  const head = document.createElement("div");
  head.className = "cb-tm-h";
  head.textContent = "Send to";
  bcastTargetMenu.appendChild(head);

  const fleet = document.createElement("button");
  fleet.className = "cb-tm-item" + (targetId === null ? " sel" : "");
  fleet.type = "button";
  fleet.setAttribute("role", "option");
  fleet.innerHTML =
    `<span class="cb-tm-ic">${BROADCAST_IC}</span>` +
    `<span class="cb-tm-nm">Everyone</span>` +
    `<span class="cb-tm-sub">${activeRunning().length} running</span>`;
  fleet.addEventListener("mousedown", (e) => {
    e.preventDefault();
    setTarget(null);
  });
  bcastTargetMenu.appendChild(fleet);

  for (const p of agents) {
    const letter = (p.spec.name.trim()[0] ?? "?").toUpperCase();
    const status = p.running ? (p.attention ? "needs you" : "running") : "stopped";
    const btn = document.createElement("button");
    btn.className = "cb-tm-item" + (targetId === p.id ? " sel" : "");
    btn.type = "button";
    btn.setAttribute("role", "option");
    btn.innerHTML =
      `<span class="cb-tm-av" style="background:${p.color}">${letter}</span>` +
      `<span class="cb-tm-nm">${p.spec.name}</span>` +
      `<span class="cb-tm-sub st-${p.running ? (p.attention ? "needs" : "run") : "stop"}">${status}</span>`;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      setTarget(p.id);
    });
    bcastTargetMenu.appendChild(btn);
  }

  bcastTargetMenu.classList.remove("hidden");
  bcastTarget.setAttribute("aria-expanded", "true");
  targetMenuOpen = true;
}

/** Focus + select the broadcast input (Ctrl+Shift+B). */
export function focusBroadcast(): void {
  bcastInput.focus();
  bcastInput.select();
}

/** Wire every broadcast-console listener. Call once at startup. */
export function initBroadcast(): void {
  bcastInput.addEventListener("input", () => {
    bcastHistIdx = bcastHistory.length; // typing leaves history navigation
    updateBcast();
    updateAc();
  });
  bcastInput.addEventListener("keydown", (e) => {
    if (!bcastAc.classList.contains("hidden")) {
      if (e.key === "ArrowDown") { e.preventDefault(); return moveAc(1); }
      if (e.key === "ArrowUp") { e.preventDefault(); return moveAc(-1); }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); return pickAc(acItems[acSel]); }
      if (e.key === "Escape") { e.preventDefault(); return closeAc(); }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      broadcast();
    } else if (e.key === "ArrowUp" && bcastHistory.length) {
      e.preventDefault();
      bcastHistIdx = Math.max(0, bcastHistIdx - 1);
      bcastInput.value = bcastHistory[bcastHistIdx] ?? "";
      updateBcast();
    } else if (e.key === "ArrowDown" && bcastHistory.length) {
      e.preventDefault();
      bcastHistIdx = Math.min(bcastHistory.length, bcastHistIdx + 1);
      bcastInput.value = bcastHistory[bcastHistIdx] ?? "";
      updateBcast();
    }
  });
  bcastSend.addEventListener("click", broadcast);
  bcastInput.addEventListener("blur", () => window.setTimeout(closeAc, 120));

  // Target chip: open the picker, close on outside click / Escape.
  renderTargetChip();
  bcastTarget.addEventListener("click", (e) => {
    e.stopPropagation();
    if (targetMenuOpen) closeTargetMenu();
    else openTargetMenu();
  });
  document.addEventListener("click", (e) => {
    if (!targetMenuOpen) return;
    const t = e.target as Node;
    if (!bcastTargetMenu.contains(t) && !bcastTarget.contains(t)) closeTargetMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && targetMenuOpen) {
      closeTargetMenu();
      bcastInput.focus();
    }
  });
}
