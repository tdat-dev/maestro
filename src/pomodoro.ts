/* Pomodoro timer — one timer per workspace folder. A single 1-second loop ticks
 * every workspace's timer, so a focus session keeps running while you switch
 * tabs and fires an OS notification when a phase ends. The panel renders the
 * active workspace's timer; the rail shows a live mm:ss badge. See dock.ts. */

import { notify } from "./ipc";
import { loadJSON, saveJSON, type DockContext } from "./dockstore";

type Phase = "focus" | "break" | "long";

interface Persisted {
  focusMin: number;
  breakMin: number;
  completed: number;
}
interface PomoState extends Persisted {
  phase: Phase;
  remaining: number; // seconds left in the current phase
  running: boolean;
}

const LONG_MIN = 15;
const PER_SET = 4; // focus sessions before a long break
const FOCUS_DEFAULT = 25;
const BREAK_DEFAULT = 5;

const keyFor = (ctxKey: string) => `maestro.pomodoro.v1.${ctxKey}`;
const clampMin = (n: number) => Math.min(90, Math.max(1, Math.round(n)));

const PHASE_LABEL: Record<Phase, string> = {
  focus: "Focus",
  break: "Break",
  long: "Long break",
};

function phaseSeconds(s: PomoState, phase: Phase): number {
  if (phase === "focus") return s.focusMin * 60;
  if (phase === "break") return s.breakMin * 60;
  return LONG_MIN * 60;
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function el(tag: string, cls?: string, html?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

export function createPomodoro() {
  const states = new Map<string, PomoState>();
  let ctx: DockContext | null = null;
  let root: HTMLElement | null = null;
  let badge: HTMLElement | null = null;
  let badgeBtn: HTMLElement | null = null;
  let started = false;

  function load(key: string): PomoState {
    const p = loadJSON<Persisted>(keyFor(key), {
      focusMin: FOCUS_DEFAULT,
      breakMin: BREAK_DEFAULT,
      completed: 0,
    });
    const focusMin = clampMin(p.focusMin ?? FOCUS_DEFAULT);
    const breakMin = clampMin(p.breakMin ?? BREAK_DEFAULT);
    return {
      focusMin,
      breakMin,
      completed: Math.max(0, p.completed ?? 0),
      phase: "focus",
      remaining: focusMin * 60,
      running: false,
    };
  }

  function persist(s: PomoState, key: string) {
    saveJSON(keyFor(key), {
      focusMin: s.focusMin,
      breakMin: s.breakMin,
      completed: s.completed,
    } satisfies Persisted);
  }

  function state(): PomoState | null {
    if (!ctx) return null;
    let s = states.get(ctx.key);
    if (!s) {
      s = load(ctx.key);
      states.set(ctx.key, s);
    }
    return s;
  }

  function nextPhase(s: PomoState): Phase {
    if (s.phase === "focus") return s.completed % PER_SET === 0 ? "long" : "break";
    return "focus";
  }

  function advance(s: PomoState, auto: boolean) {
    if (s.phase === "focus") s.completed += 1;
    const next = nextPhase(s);
    s.phase = next;
    s.remaining = phaseSeconds(s, next);
    s.running = auto; // auto-continue when a phase elapses; manual Skip pauses
    if (auto) {
      const msg =
        next === "focus"
          ? "Break over. Back to focus."
          : "Focus session done. Time for a break.";
      void notify("Pomodoro", msg);
    }
  }

  function tickAll() {
    let activeChanged = false;
    for (const [key, s] of states) {
      if (!s.running) continue;
      s.remaining -= 1;
      if (s.remaining <= 0) {
        advance(s, true);
        persist(s, key);
      }
      if (ctx && key === ctx.key) activeChanged = true;
    }
    if (activeChanged) renderActive();
    updateBadge();
  }

  function updateBadge() {
    if (!badge || !badgeBtn) return;
    const s = state();
    badgeBtn.classList.toggle("running", !!s?.running);
    badgeBtn.dataset.phase = s?.phase ?? "focus";
    badge.textContent = s && s.running ? mmss(s.remaining) : "";
    badge.hidden = !(s && s.running);
  }

  // ---- controls ----
  function toggleRun() {
    const s = state();
    if (!s) return;
    s.running = !s.running;
    renderActive();
    updateBadge();
  }
  function reset() {
    const s = state();
    if (!s || !ctx) return;
    s.phase = "focus";
    s.remaining = s.focusMin * 60;
    s.running = false;
    persist(s, ctx.key);
    renderActive();
    updateBadge();
  }
  function skip() {
    const s = state();
    if (!s || !ctx) return;
    advance(s, false);
    persist(s, ctx.key);
    renderActive();
    updateBadge();
  }
  function setLen(which: "focusMin" | "breakMin", delta: number) {
    const s = state();
    if (!s || !ctx) return;
    s[which] = clampMin(s[which] + delta);
    // if idle and editing the current phase length, reflect it on the clock
    if (!s.running) {
      if (which === "focusMin" && s.phase === "focus") s.remaining = s.focusMin * 60;
      if (which === "breakMin" && s.phase === "break") s.remaining = s.breakMin * 60;
    }
    persist(s, ctx.key);
    renderActive();
  }

  function dots(s: PomoState): string {
    const inSet = s.completed % PER_SET || (s.completed && s.phase === "long" ? PER_SET : 0);
    return Array.from({ length: PER_SET }, (_, i) =>
      `<span class="pm-dot${i < inSet ? " on" : ""}"></span>`,
    ).join("");
  }

  function renderActive() {
    if (!root) return;
    const s = state();
    root.replaceChildren();
    if (!s) {
      root.appendChild(el("div", "pm-empty", "<p>Open a workspace to start a timer.</p>"));
      return;
    }
    const total = phaseSeconds(s, s.phase);
    const frac = total > 0 ? s.remaining / total : 0;
    const offset = RING_C * (1 - frac);

    const wrap = el("div", `pm-wrap phase-${s.phase}${s.running ? " running" : ""}`);
    wrap.innerHTML = `
      <div class="pm-dial">
        <svg viewBox="0 0 120 120" class="pm-ring">
          <circle class="pm-track" cx="60" cy="60" r="${RING_R}"></circle>
          <circle class="pm-prog" cx="60" cy="60" r="${RING_R}"
            stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
        </svg>
        <div class="pm-center">
          <span class="pm-phase">${PHASE_LABEL[s.phase]}</span>
          <span class="pm-time">${mmss(s.remaining)}</span>
          <span class="pm-dots">${dots(s)}</span>
        </div>
      </div>
      <div class="pm-controls">
        <button class="pm-btn pm-skip" data-skip title="Skip phase">Skip</button>
        <button class="pm-btn pm-primary" data-toggle>${s.running ? "Pause" : "Start"}</button>
        <button class="pm-btn pm-reset" data-reset title="Reset to a fresh focus block">Reset</button>
      </div>
      <div class="pm-config">
        <div class="pm-len">
          <span class="pm-len-l">Focus</span>
          <div class="pm-step" data-len="focusMin">
            <button data-dec aria-label="Less focus time">−</button>
            <b>${s.focusMin}<em>m</em></b>
            <button data-inc aria-label="More focus time">+</button>
          </div>
        </div>
        <div class="pm-len">
          <span class="pm-len-l">Break</span>
          <div class="pm-step" data-len="breakMin">
            <button data-dec aria-label="Less break time">−</button>
            <b>${s.breakMin}<em>m</em></b>
            <button data-inc aria-label="More break time">+</button>
          </div>
        </div>
        <span class="pm-total">${s.completed} done today</span>
      </div>`;

    wrap.querySelector("[data-toggle]")?.addEventListener("click", toggleRun);
    wrap.querySelector("[data-reset]")?.addEventListener("click", reset);
    wrap.querySelector("[data-skip]")?.addEventListener("click", skip);
    wrap.querySelectorAll<HTMLElement>(".pm-step").forEach((step) => {
      const which = step.dataset.len as "focusMin" | "breakMin";
      step.querySelector("[data-dec]")?.addEventListener("click", () => setLen(which, -1));
      step.querySelector("[data-inc]")?.addEventListener("click", () => setLen(which, +1));
    });
    root.appendChild(wrap);
  }

  return {
    mount(body: HTMLElement) {
      root = el("div", "pm-root");
      body.appendChild(root);
      if (!started) {
        started = true;
        window.setInterval(tickAll, 1000);
      }
      renderActive();
    },
    /** The dock hands the pomodoro rail button so the badge can tick live. */
    attachBadge(button: HTMLElement) {
      badgeBtn = button;
      badge = button.querySelector(".dr-timer");
      updateBadge();
    },
    setContext(next: DockContext | null) {
      ctx = next;
      renderActive();
      updateBadge();
    },
    show() {
      renderActive();
    },
  };
}
