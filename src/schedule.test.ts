import { describe, it, expect } from "vitest";
import {
  parseTime,
  isDue,
  dueSchedules,
  afterFire,
  nextRun,
  type Schedule,
} from "./schedule";

const at = (h: number, m: number) => {
  const d = new Date(2026, 6, 10, h, m, 0, 0); // 2026-07-10 local
  return d;
};
const sched = (over: Partial<Schedule> = {}): Schedule => ({
  id: "s1",
  templateId: "t1",
  time: "09:30",
  repeat: "daily",
  enabled: true,
  ...over,
});

describe("parseTime", () => {
  it("accepts valid HH:MM and rejects junk", () => {
    expect(parseTime("09:30")).toEqual({ h: 9, m: 30 });
    expect(parseTime("23:59")).toEqual({ h: 23, m: 59 });
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("9:5")).toBeNull();
    expect(parseTime("nope")).toBeNull();
  });
});

describe("isDue", () => {
  it("not due before the slot", () => {
    expect(isDue(sched(), at(9, 29))).toBe(false);
  });
  it("due at/after the slot when not yet fired", () => {
    expect(isDue(sched(), at(9, 30))).toBe(true);
    expect(isDue(sched(), at(10, 0))).toBe(true);
  });
  it("not due again once fired for this slot", () => {
    const fired = sched({ lastFired: at(9, 30).getTime() });
    expect(isDue(fired, at(9, 45))).toBe(false);
  });
  it("disabled schedules are never due", () => {
    expect(isDue(sched({ enabled: false }), at(10, 0))).toBe(false);
  });
});

describe("afterFire", () => {
  it("stamps lastFired and keeps daily enabled", () => {
    const s = afterFire(sched(), at(9, 30));
    expect(s.lastFired).toBe(at(9, 30).getTime());
    expect(s.enabled).toBe(true);
  });
  it("disables a once schedule after firing", () => {
    const s = afterFire(sched({ repeat: "once" }), at(9, 30));
    expect(s.enabled).toBe(false);
  });
});

describe("dueSchedules", () => {
  it("returns only the due, enabled ones", () => {
    const list = [
      sched({ id: "a", time: "09:00" }),
      sched({ id: "b", time: "10:00" }),
      sched({ id: "c", time: "08:00", enabled: false }),
    ];
    expect(dueSchedules(list, at(9, 30)).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("nextRun", () => {
  it("shows later-today before the slot", () => {
    expect(nextRun(sched(), at(8, 0))?.getHours()).toBe(9);
  });
  it("daily rolls to tomorrow once fired", () => {
    const fired = sched({ lastFired: at(9, 30).getTime() });
    const next = nextRun(fired, at(10, 0));
    expect(next?.getDate()).toBe(11);
  });
  it("once returns null after it has passed", () => {
    const fired = sched({ repeat: "once", lastFired: at(9, 30).getTime() });
    expect(nextRun(fired, at(10, 0))).toBeNull();
  });
});
