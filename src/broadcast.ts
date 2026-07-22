// The broadcast console: type once, signal the whole tab. A message with no
// @mention goes to every running agent; an "@name …" line routes to just that
// agent. Handles @mention routing + the name-picker autocomplete and input
// history. Split out of main.ts; the active workspace is read through an
// injected getter so this module never imports back into main (no cycle).

import { sendInput } from "./ipc";
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

function activeRunning(): Pane[] {
  const ws = getWs();
  return ws ? [...ws.panes.values()].filter((p) => p.running) : [];
}
// Every agent in the active workspace, running or idle. The @mention picker and
// name-resolution use this (so a parked/finished agent still autocompletes and
// resolves), while a no-mention broadcast still only reaches the running ones.
function activeAgents(): Pane[] {
  const ws = getWs();
  return ws ? [...ws.panes.values()] : [];
}

export function updateBcast(): void {
  const allAgents = activeAgents();
  // Default: the whole running fleet. An "@name …" line narrows it to that one
  // (matched against every agent, so an idle name is recognised, not spammed).
  let targets = activeRunning();

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
  let sentAny = false;
  for (const seg of segs) {
    if (!seg.body) continue;
    const targets = seg.name
      ? allRunning.filter((p) => p.spec.name.toLowerCase() === seg.name!.toLowerCase())
      : allRunning; // no @mention → the whole running fleet
    for (const p of targets) {
      void sendInput(p.id, seg.body + "\r").catch(() => {});
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
}
