/* Scheduled agents — fire a saved crew template at a time of day, once or
 * daily. Pure engine (no DOM/timers/Date.now): the caller passes `now` and
 * applies the result. main.ts owns the tick, persistence, and launching. */

export type Repeat = "once" | "daily";

export interface Schedule {
  id: string;
  templateId: string; // which saved crew template to launch
  time: string; // "HH:MM" 24h, local
  repeat: Repeat;
  enabled: boolean;
  lastFired?: number; // ms epoch of the last fire (per-slot dedup)
}

/** Parse "HH:MM" → {h,m}, or null if malformed. */
export function parseTime(t: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

/** Today's occurrence of a schedule's time, or null if the time is malformed. */
export function slotToday(s: Schedule, now: Date): Date | null {
  const hm = parseTime(s.time);
  if (!hm) return null;
  const d = new Date(now);
  d.setHours(hm.h, hm.m, 0, 0);
  return d;
}

/** Is this schedule due to fire at `now`? Due once per HH:MM slot: now has
 *  reached today's slot and it hasn't fired for that slot yet. Disabled or
 *  malformed schedules are never due. */
export function isDue(s: Schedule, now: Date): boolean {
  if (!s.enabled) return false;
  const slot = slotToday(s, now);
  if (!slot) return false;
  if (now.getTime() < slot.getTime()) return false;
  return (s.lastFired ?? 0) < slot.getTime();
}

/** Every schedule that should fire now, in list order. */
export function dueSchedules(schedules: Schedule[], now: Date): Schedule[] {
  return schedules.filter((s) => isDue(s, now));
}

/** The schedule after it fires at `now`: stamps lastFired; a "once" schedule
 *  also disables itself so it can't run again. */
export function afterFire(s: Schedule, now: Date): Schedule {
  return {
    ...s,
    lastFired: now.getTime(),
    enabled: s.repeat === "once" ? false : s.enabled,
  };
}

/** Next run time for display, or null (disabled / malformed / spent once). */
export function nextRun(s: Schedule, now: Date): Date | null {
  if (!s.enabled) return null;
  const slot = slotToday(s, now);
  if (!slot) return null;
  const firedThisSlot = (s.lastFired ?? 0) >= slot.getTime();
  const passed = now.getTime() >= slot.getTime();
  if (!passed && !firedThisSlot) return slot; // later today
  if (s.repeat === "once") return firedThisSlot || passed ? null : slot;
  const tomorrow = new Date(slot);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow; // daily rolls to tomorrow
}
