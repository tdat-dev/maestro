// The broadcast console: type once, signal the whole tab. Handles @mention
// routing + the name-picker autocomplete, per-agent target selection, and input
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
const bcastCountEl = document.getElementById("bcastCount");
const bcastEmitter = document.getElementById("bcastEmitter");
const bcastTargets = document.getElementById("bcastTargets");
const bcastTargetBtn = document.getElementById("bcastTargetBtn") as HTMLButtonElement;
const bcastMenu = document.getElementById("bcastMenu") as HTMLElement;
const bcastSelectAll = document.getElementById("bcastSelectAll") as HTMLButtonElement;
const bcastDeselectAll = document.getElementById("bcastDeselectAll") as HTMLButtonElement;
const bcastAc = document.getElementById("bcastAc") as HTMLElement;

function activeRunning(): Pane[] {
  const ws = getWs();
  return ws ? [...ws.panes.values()].filter((p) => p.running) : [];
}

export function updateBcast(): void {
  const ws = getWs();
  const allRunning = activeRunning();
  let targets = allRunning.filter((p) => ws?.bcastSelected.has(p.id));
  let isAutoRouted = false;

  const text = bcastInput?.value || "";
  const sorted = [...allRunning].sort((a, b) => b.spec.name.length - a.spec.name.length);
  let matchedName = "";
  for (const p of sorted) {
    const escapedName = p.spec.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^@?${escapedName}(?:[-\\s]?([1-9][0-9]*))?[:,]?(?:\\s+|$)`, "i");
    const match = text.match(regex);
    if (match) {
      const exactMatches = allRunning.filter((agent) => agent.spec.name.toLowerCase() === p.spec.name.toLowerCase());
      if (match[1]) {
        const idx = parseInt(match[1], 10) - 1;
        if (idx >= 0 && idx < exactMatches.length) {
          targets = [exactMatches[idx]];
          matchedName = `${p.spec.name} #${idx + 1}`;
        } else {
          targets = []; // out-of-bounds index
        }
      } else {
        targets = exactMatches;
        matchedName = p.spec.name;
      }
      isAutoRouted = true;
      break;
    }
  }

  const n = targets.length;
  if (bcastCountEl) {
    if (isAutoRouted) {
      bcastCountEl.textContent = n > 1 ? `${n} ${matchedName}s` : `${matchedName} only`;
    } else {
      bcastCountEl.textContent = allRunning.length === 0 ? "0 agents" : `${n} selected`;
    }
  }
  bcastSend.disabled = n === 0 || bcastInput.value.length === 0;
  bcastEmitter?.classList.toggle("live", n > 0);
  if (bcastTargets) {
    bcastTargets.replaceChildren();
    for (const p of allRunning) {
      const on = targets.includes(p);
      const row = document.createElement("div");
      row.className = "bcast-row" + (on ? "" : " off");
      row.style.setProperty("--c", p.color);
      const dot = document.createElement("span");
      dot.className = "t";
      const name = document.createElement("span");
      name.className = "bcast-row-name";
      name.textContent = p.spec.name;
      const check = document.createElement("div");
      check.className = "bcast-row-check";
      check.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
      row.append(dot, name, check);
      row.addEventListener("click", () => {
        const w = getWs();
        if (!w) return;
        if (w.bcastSelected.has(p.id)) w.bcastSelected.delete(p.id);
        else w.bcastSelected.add(p.id);
        updateBcast();
      });
      bcastTargets.appendChild(row);
    }
  }
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
  const ws = getWs();
  const originalText = bcastInput.value;
  const allRunning = activeRunning();
  const names = allRunning.map((p) => p.spec.name);
  // A line can name several agents: "@Ana run tests @Bob deploy". Text before
  // any mention (or a line with no mention) goes to the selected/whole fleet.
  const segs = splitMentions(originalText, names);
  let sentAny = false;
  for (const seg of segs) {
    if (!seg.body) continue;
    const targets = seg.name
      ? allRunning.filter((p) => p.spec.name.toLowerCase() === seg.name!.toLowerCase())
      : allRunning.filter((p) => ws?.bcastSelected.has(p.id));
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
  return activeRunning().find((p) => p.spec.name === name)?.color ?? "var(--muted)";
}
function nameMeta(name: string): string {
  const p = activeRunning().find((p) => p.spec.name === name);
  if (!p) return "";
  return `${p.spec.badge} · ${p.running ? "running" : "idle"}`;
}
function updateAc(): void {
  const q = activeMention(bcastInput.value, bcastInput.selectionStart ?? bcastInput.value.length);
  if (q === null) return closeAc();
  const names = [...new Set(activeRunning().map((p) => p.spec.name))];
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

  bcastTargetBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = bcastMenu.classList.toggle("hidden");
    document.querySelector(".bcast-target-wrapper")?.classList.toggle("open", !open);
  });
  document.addEventListener("click", (e) => {
    if (!bcastMenu?.classList.contains("hidden") && !bcastMenu?.contains(e.target as Node) && !bcastTargetBtn?.contains(e.target as Node)) {
      bcastMenu?.classList.add("hidden");
      document.querySelector(".bcast-target-wrapper")?.classList.remove("open");
    }
  });
  bcastSelectAll?.addEventListener("click", () => {
    const ws = getWs();
    if (!ws) return;
    for (const p of activeRunning()) ws.bcastSelected.add(p.id);
    updateBcast();
  });
  bcastDeselectAll?.addEventListener("click", () => {
    const ws = getWs();
    if (!ws) return;
    ws.bcastSelected.clear();
    updateBcast();
  });
}
