// Scheduled agents: fire a saved crew template at a time of day, once or
// daily. Split from main.ts; the schedule engine lives in schedule.ts (pure,
// no DOM/timers). Templates are owned by main.ts (the wizard's preset store),
// so loading one and launching it are injected.

import { type CrewState, expandCrew } from "./crew";
import {
  parseTime,
  dueSchedules,
  afterFire,
  nextRun,
  type Schedule,
} from "./schedule";

/** Shape of a saved crew template (owned by main.ts's preset wizard); only the
 *  fields the scheduler reads. */
interface TemplateLite {
  id: string;
  name: string;
  counts: Record<string, number>;
  custom: string;
  customCount: number;
  dir: string;
  skipPerms: boolean;
}

let onCloseSettings: () => void = () => {};
let onLoadTemplates: () => TemplateLite[] = () => [];
let onLaunchPreset: (state: CrewState, presetDir: string, skipPerms: boolean) => void = () => {};
export function configureScheduler(deps: {
  closeSettings: () => void;
  loadTemplates: () => TemplateLite[];
  launchPreset: (state: CrewState, presetDir: string, skipPerms: boolean) => void;
}): void {
  onCloseSettings = deps.closeSettings;
  onLoadTemplates = deps.loadTemplates;
  onLaunchPreset = deps.launchPreset;
}

const SCHED_KEY = "maestro.schedules";
const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function loadSchedules(): Schedule[] {
  try {
    const v = JSON.parse(localStorage.getItem(SCHED_KEY) || "[]");
    return Array.isArray(v) ? (v as Schedule[]) : [];
  } catch {
    return [];
  }
}
function saveSchedules(list: Schedule[]) {
  try {
    localStorage.setItem(SCHED_KEY, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
}

/** Launch a saved template now (a scheduled fire or the manual test button). */
function launchTemplate(t: TemplateLite): void {
  const state: CrewState = { counts: { ...t.counts }, custom: t.custom, customCount: t.customCount };
  if (expandCrew(state).length === 0) return;
  onLaunchPreset(state, t.dir, t.skipPerms);
}

const schedModal = document.getElementById("schedModal") as HTMLElement | null;
const schedTpl = document.getElementById("schedTpl") as HTMLSelectElement | null;
const schedTime = document.getElementById("schedTime") as HTMLInputElement | null;
const schedRepeat = document.getElementById("schedRepeat") as HTMLSelectElement | null;
const schedList = document.getElementById("schedList");
const schedEmpty = document.getElementById("schedEmpty");

function renderSchedList(): void {
  if (!schedList) return;
  const list = loadSchedules();
  const templates = onLoadTemplates();
  const nameOf = (id: string) => templates.find((t) => t.id === id)?.name;
  schedList.replaceChildren();
  if (schedEmpty) schedEmpty.hidden = list.length > 0;
  const now = new Date();
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "sched-row" + (s.enabled ? "" : " off");
    const tplName = nameOf(s.templateId);
    const next = nextRun(s, now);
    const nextLabel = !s.enabled
      ? "paused"
      : next
        ? next.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
        : "done";
    row.innerHTML =
      `<label class="sched-en"><input type="checkbox" ${s.enabled ? "checked" : ""}><span class="pt-sw"></span></label>` +
      `<span class="sched-name">${tplName ? escHtml(tplName) : "<i>preset deleted</i>"}</span>` +
      `<span class="sched-when">${escHtml(s.time)} · ${s.repeat === "daily" ? "daily" : "once"}</span>` +
      `<span class="sched-next">${escHtml(nextLabel)}</span>` +
      `<button class="sched-del" aria-label="Delete schedule">✕</button>`;
    row.querySelector<HTMLInputElement>("input")?.addEventListener("change", () => {
      saveSchedules(loadSchedules().map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)));
      renderSchedList();
    });
    row.querySelector(".sched-del")?.addEventListener("click", () => {
      saveSchedules(loadSchedules().filter((x) => x.id !== s.id));
      renderSchedList();
    });
    schedList.appendChild(row);
  }
}

function openScheduler(): void {
  if (!schedModal || !schedTpl) return;
  const templates = onLoadTemplates();
  schedTpl.innerHTML = templates.length
    ? templates.map((t) => `<option value="${escHtml(t.id)}">${escHtml(t.name)}</option>`).join("")
    : `<option value="">No saved presets</option>`;
  renderSchedList();
  schedModal.classList.add("open");
}
function closeScheduler(): void {
  schedModal?.classList.remove("open");
}

/** Wire the scheduler modal's controls and start the fire-loop. Call once at
 *  startup. */
export function initScheduler(): void {
  document.getElementById("setOpenSched")?.addEventListener("click", () => {
    onCloseSettings();
    openScheduler();
  });
  document.getElementById("schedClose")?.addEventListener("click", closeScheduler);
  document.getElementById("schedCloseBtn")?.addEventListener("click", closeScheduler);
  schedModal?.addEventListener("mousedown", (e) => {
    if (e.target === schedModal) closeScheduler();
  });
  document.getElementById("schedAdd")?.addEventListener("click", () => {
    if (!schedTpl || !schedTime || !schedRepeat) return;
    const templateId = schedTpl.value;
    if (!templateId) return; // no presets saved
    if (!parseTime(schedTime.value)) return; // guard malformed time
    const s: Schedule = {
      id: "sc-" + Math.random().toString(36).slice(2, 9),
      templateId,
      time: schedTime.value,
      repeat: schedRepeat.value === "once" ? "once" : "daily",
      enabled: true,
    };
    saveSchedules([...loadSchedules(), s]);
    renderSchedList();
  });

  // Tick: fire any due schedule, then stamp it (a "once" schedule disables
  // itself). 30s cadence is plenty for minute-resolution times.
  window.setInterval(() => {
    const now = new Date();
    const list = loadSchedules();
    const due = dueSchedules(list, now);
    if (!due.length) return;
    const templates = onLoadTemplates();
    for (const s of due) {
      const tpl = templates.find((t) => t.id === s.templateId);
      if (tpl) launchTemplate(tpl);
    }
    const fired = new Set(due.map((s) => s.id));
    saveSchedules(list.map((s) => (fired.has(s.id) ? afterFire(s, now) : s)));
    if (schedModal?.classList.contains("open")) renderSchedList();
  }, 30_000);
}
