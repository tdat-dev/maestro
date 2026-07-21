// Home mascot companion. A friendly character on the Home screen. Two modes
// (Settings → Mascot): "move" strolls back and forth on its own; "still"
// stays put, idle. In either mode it can be grabbed and dropped anywhere
// (position persists). Split from main.ts; no injected deps — everything it
// touches comes from ./mascot and ./settings.

import { Mascot } from "./mascot";
import {
  getMascotMode,
  setMascotMode,
  getMascotPos,
  setMascotPos,
  type MascotMode,
} from "./settings";

/* ---------------- home mascot companion ---------------- */
// The wrapper (#homeMascot) is translate(x,y)-positioned; the Mascot instance
// owns its own scale + facing flip. Strolling pauses when Home is off screen.
function initHomeMascot(): void {
  const host = document.getElementById("homeMascot");
  const home = document.getElementById("home");
  if (!host || !home || !Mascot.animations().includes("boy_idle")) return;

  const SPEED = 78; // px/sec — tuned so feet roughly match ground travel (low slide)
  const BOXW = 180,
    BOXH = 262; // .home-mascot box size (keep in sync with home.css)
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const m = new Mascot(host, { scale: 0.62, initial: "boy_idle" });
  void Mascot.preload(["boy_idle", "boy_walk"]);

  let mode: MascotMode = getMascotMode();
  let dragging = false;
  let moveAnim: Animation | null = null;
  let strollTimer = 0;

  const homeW = () => home.clientWidth || window.innerWidth;
  const homeH = () => home.clientHeight || window.innerHeight;
  const visible = () => !home.hidden && home.clientWidth > 0;
  const clamp = (p: { x: number; y: number }) => ({
    x: Math.min(Math.max(0, p.x), Math.max(0, homeW() - BOXW)),
    y: Math.min(Math.max(0, p.y), Math.max(0, homeH() - BOXH)),
  });
  // default resting spot: lower-left, feet ~30px above the Home bottom
  let pos = clamp(getMascotPos() ?? { x: 44, y: homeH() - BOXH - 30 });
  const apply = () => (host.style.transform = `translate(${pos.x}px, ${pos.y}px)`);
  apply();

  const stopStroll = () => {
    window.clearTimeout(strollTimer);
    moveAnim?.cancel();
    moveAnim = null;
  };

  const strollOnce = () => {
    if (mode !== "move" || dragging) return;
    if (!visible()) {
      strollTimer = window.setTimeout(strollOnce, 1200);
      return;
    }
    const maxX = Math.max(0, homeW() - BOXW);
    // A believable hop (160–360px) toward the side with more room.
    const dir = pos.x < maxX - pos.x ? 1 : -1;
    const target = Math.max(0, Math.min(maxX, pos.x + rand(160, 360) * (Math.random() < 0.8 ? dir : -dir)));
    const dist = Math.abs(target - pos.x);
    if (dist < 40) {
      strollTimer = window.setTimeout(strollOnce, 700);
      return;
    }
    const dur = (dist / SPEED) * 1000;
    m.setFacing(target < pos.x ? "left" : "right");
    m.play("boy_walk");
    // Walk along the current height (y): pre-set resting transform to the
    // destination, then animate current → destination so the hand-off to idle is
    // seamless (no fill-forwards pile-up).
    const from = pos.x;
    pos.x = target;
    apply();
    moveAnim = host.animate(
      [
        { transform: `translate(${from}px, ${pos.y}px)` },
        { transform: `translate(${target}px, ${pos.y}px)` },
      ],
      { duration: dur, easing: "linear" },
    );
    moveAnim.finished
      .then(() => {
        if (mode !== "move" || dragging) return;
        m.setFacing("right");
        m.play("boy_idle");
        strollTimer = window.setTimeout(strollOnce, rand(1800, 4200));
      })
      .catch(() => {}); // cancelled (drag / mode switch / teardown)
  };

  const applyMode = (next: MascotMode) => {
    mode = next;
    setMascotMode(next);
    stopStroll();
    m.setFacing("right");
    m.play("boy_idle");
    apply();
    if (mode === "move") strollTimer = window.setTimeout(strollOnce, 500);
  };

  /* ---- drag to place ---- */
  let grabDX = 0,
    grabDY = 0,
    grabPid = -1;
  m.el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    stopStroll();
    m.play("boy_idle"); // hold idle while being carried
    grabDX = e.clientX - pos.x;
    grabDY = e.clientY - pos.y;
    grabPid = e.pointerId;
    try {
      m.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    host.classList.add("dragging");
  });
  m.el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    pos = clamp({ x: e.clientX - grabDX, y: e.clientY - grabDY });
    apply();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    host.classList.remove("dragging");
    try {
      m.el.releasePointerCapture(grabPid);
    } catch {
      /* ignore */
    }
    setMascotPos(pos.x, pos.y);
    if (mode === "move") strollTimer = window.setTimeout(strollOnce, 500);
  };
  m.el.addEventListener("pointerup", endDrag);
  m.el.addEventListener("pointercancel", endDrag);

  /* ---- Settings → Mascot mode toggle ---- */
  const seg = document.getElementById("setMascotMode");
  const syncSeg = () =>
    seg?.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  seg?.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
    b.addEventListener("click", () => {
      applyMode((b.dataset.mode as MascotMode) ?? "move");
      syncSeg();
    }),
  );
  syncSeg();

  // Keep the mascot on-screen if the window is resized.
  window.addEventListener("resize", () => {
    pos = clamp(pos);
    if (!dragging && !moveAnim) apply();
  });

  if (mode === "move") strollTimer = window.setTimeout(strollOnce, 1500);
}

/** Wire the home mascot companion. Call once at startup. */
export function initMascotView(): void {
  initHomeMascot();
}
