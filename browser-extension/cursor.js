/* The agent's cursor, drawn over the page it works in (injected with
 * chrome.scripting.executeScript, so it must be self-contained).
 *
 * It glides to where the agent is about to act, presses there, and wears the
 * agent's name and colour. While the agent works, a thin frame and a pill
 * ("Ana is using this tab" · Stop) show; after a few idle seconds all of it
 * fades away.
 *
 * Built to cost nothing on a slow machine:
 * - frames run only while the cursor travels (0.2–0.6 s), never while idle;
 * - only transform and opacity change, so the compositor does the work and
 *   the page is never laid out again;
 * - no backdrop blur and no per-frame filters: the cursor's shadow is part of
 *   its SVG;
 * - the pulsing dot stops whenever the overlay is idle;
 * - the layer is `contain: strict` and never takes the mouse.
 *
 * op: "move" {x, y} (resolves on arrival) · "click" {x, y, button} ·
 *     "key" {text} · "type" {text} · "show" · "hide" / "unhide" (around the
 *     agent's own screenshots). Every op carries {name, color, from}. */
export function cursorAct(op, o) {
  const IDLE_MS = 6000;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let S = globalThis.__maestroCursor;
  if (!S || !S.host.isConnected) {
    const host = document.createElement("div");
    host.setAttribute("data-maestro-overlay", "");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
<style>
  :host{all:initial}
  *{box-sizing:border-box}
  .frame{position:fixed;inset:0;box-shadow:inset 0 0 0 2px var(--c),inset 0 0 18px 0 var(--c-soft);opacity:0;transition:opacity .35s ease}
  .pill{position:fixed;top:10px;left:50%;display:flex;align-items:center;gap:10px;padding:6px 6px 6px 12px;border-radius:999px;
    background:#16161a;color:#f4f4f5;font:500 12.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.1px;
    box-shadow:0 6px 20px rgba(0,0,0,.3),0 0 0 1px rgba(255,255,255,.09);opacity:0;transform:translate(-50%,-6px);
    transition:opacity .3s ease,transform .3s cubic-bezier(.2,.8,.2,1);pointer-events:none}
  .pill i{width:8px;height:8px;border-radius:50%;background:var(--c);box-shadow:0 0 0 3px var(--c-soft);animation:beat 1.6s ease-in-out infinite;animation-play-state:paused}
  .pill b{font-weight:650}
  .pill button{all:unset;cursor:pointer;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.1);color:#fff;font:600 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif}
  .pill button:hover{background:#e5484d}
  .pill button:focus-visible{outline:2px solid #fff;outline-offset:2px}
  .pill.stopped i{background:#f0bf6a;box-shadow:0 0 0 3px rgba(240,191,106,.3)}
  .on .frame{opacity:1}
  .on .pill{opacity:1;transform:translate(-50%,0);pointer-events:auto}
  .on .pill i{animation-play-state:running}
  .pill.stopped i{animation:none}
  .cur{position:fixed;left:0;top:0;opacity:0;transition:opacity .25s ease}
  .moving{will-change:transform}
  .on .cur{opacity:1}
  .arrow{display:block;transform-origin:4px 3px;transition:transform .09s ease-out}
  .press .arrow{transform:scale(.84)}
  .tag{position:absolute;left:18px;top:21px;padding:4px 8px;border-radius:7px;background:var(--c);color:#fff;white-space:nowrap;
    font:600 11.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 3px 10px rgba(0,0,0,.22)}
  .chip{position:absolute;left:18px;top:45px;padding:5px 8px;border-radius:7px;background:#16161a;color:#f4f4f5;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;
    font:500 11.5px/1 ui-monospace,"Cascadia Code",Consolas,monospace;box-shadow:0 0 0 1px rgba(255,255,255,.09);opacity:0;transform:translateY(-3px);transition:opacity .18s ease,transform .18s ease}
  .chip.show{opacity:1;transform:none}
  .ring{position:fixed;left:0;top:0;width:12px;height:12px;border-radius:50%;border:2px solid var(--c);animation:ring .55s cubic-bezier(.2,.7,.3,1) forwards}
  .ring.two{animation-delay:.08s;opacity:0;border-width:1.5px}
  .dot{position:fixed;left:0;top:0;width:8px;height:8px;border-radius:50%;background:var(--c);animation:dot .45s ease-out forwards}
  @keyframes ring{0%{transform:translate(var(--x),var(--y)) translate(-50%,-50%) scale(.4);opacity:.9}100%{transform:translate(var(--x),var(--y)) translate(-50%,-50%) scale(4.2);opacity:0}}
  @keyframes dot{0%{transform:translate(var(--x),var(--y)) translate(-50%,-50%) scale(1);opacity:.9}100%{transform:translate(var(--x),var(--y)) translate(-50%,-50%) scale(.2);opacity:0}}
  @keyframes beat{50%{opacity:.45}}
  @media (prefers-reduced-motion:reduce){.ring,.dot{animation-duration:.01s}.pill i{animation:none}.cur,.frame,.pill,.chip{transition:none}}
</style>
<div class="wrap">
  <div class="frame"></div>
  <div class="pill" role="status"><i></i><span><b class="who"></b> <span class="what">is using this tab</span></span><button type="button">Stop</button></div>
  <div class="fx"></div>
  <div class="cur">
    <svg class="arrow" width="24" height="26" viewBox="0 0 24 26" aria-hidden="true">
      <path d="M4.6 4.4 20.2 15.6a.7.7 0 0 1-.36 1.27l-6.3.5-3.55 5.4a.7.7 0 0 1-1.27-.3L4.6 4.4Z" fill="rgba(0,0,0,.28)" transform="translate(.6 1.4)"/>
      <path d="M4 3.2 19.6 14.4a.7.7 0 0 1-.36 1.27l-6.3.5-3.55 5.4a.7.7 0 0 1-1.27-.3L4 3.2Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>
    </svg>
    <span class="tag"></span>
    <span class="chip"></span>
  </div>
</div>`;
    (document.body ?? document.documentElement).append(host);
    const $ = (s) => root.querySelector(s);
    S = globalThis.__maestroCursor = {
      host, wrap: $(".wrap"), cur: $(".cur"), tag: $(".tag"), chip: $(".chip"), who: $(".who"), what: $(".what"),
      pill: $(".pill"), fx: $(".fx"), x: o.from?.[0] ?? innerWidth * 0.62, y: o.from?.[1] ?? innerHeight * 0.55,
      idle: 0, chipT: 0, raf: 0, name: "",
    };
    S.pill.querySelector("button").addEventListener("click", () => {
      S.pill.classList.add("stopped");
      S.what.textContent = "is stopped. It waits for you in Maestro.";
      S.pill.querySelector("button").remove();
      try { chrome.runtime.sendMessage({ type: "stop_agent", agent: S.name }); } catch {}
    });
    // The arrow's tip is at (4,3) in its box: offset so the tip sits on the point.
    S.cur.style.transform = `translate(${S.x - 4}px,${S.y - 3}px)`;
  }
  if (o.name && o.name !== S.name) {
    S.name = o.name;
    S.tag.textContent = o.name;
    S.who.textContent = o.name;
  }
  if (o.color) {
    S.wrap.style.setProperty("--c", o.color);
    S.wrap.style.setProperty("--c-soft", `${o.color}40`);
  }
  const wake = () => {
    S.wrap.classList.add("on");
    clearTimeout(S.idle);
    S.idle = setTimeout(() => S.wrap.classList.remove("on"), IDLE_MS);
  };
  const place = (x, y) => { S.x = x; S.y = y; S.cur.style.transform = `translate(${x - 4}px,${y - 3}px)`; };
  const say = (text, ms = 1400) => {
    S.chip.textContent = text;
    S.chip.classList.add("show");
    clearTimeout(S.chipT);
    S.chipT = setTimeout(() => S.chip.classList.remove("show"), ms);
  };

  if (op === "hide") { S.host.style.visibility = "hidden"; return true; }
  if (op === "unhide") { S.host.style.visibility = ""; return true; }
  wake();
  if (op === "show") return [S.x, S.y];
  if (op === "key") { say(o.text); return true; }
  if (op === "type") { const t = o.text ?? ""; say(t.length > 28 ? `${t.slice(0, 27)}…` : t || "Typing…", 1800); return true; }

  if (op === "move") {
    const x0 = S.x, y0 = S.y, x1 = o.x, y1 = o.y;
    const d = Math.hypot(x1 - x0, y1 - y0);
    if (reduce || d < 2 || document.hidden) { place(x1, y1); return [x1, y1]; }
    // A human-looking path: a slight arc, quick start, soft landing; longer
    // trips take a little longer (Fitts), within 0.2–0.6 s.
    const ms = Math.min(600, Math.max(200, 160 + 95 * Math.log2(1 + d / 36)));
    const bend = Math.min(56, d * 0.12) * (x1 >= x0 ? 1 : -1);
    const mx = (x0 + x1) / 2 - ((y1 - y0) / d) * bend, my = (y0 + y1) / 2 + ((x1 - x0) / d) * bend;
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    cancelAnimationFrame(S.raf);
    S.cur.classList.add("moving");
    return new Promise((done) => {
      const t0 = performance.now();
      let ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        cancelAnimationFrame(S.raf);
        clearTimeout(safety);
        place(x1, y1);
        S.cur.classList.remove("moving");
        done([x1, y1]);
      };
      const safety = setTimeout(finish, ms + 150); // a tab that stops painting has no frames
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms), e = ease(t), u = 1 - e;
        place(u * u * x0 + 2 * u * e * mx + e * e * x1, u * u * y0 + 2 * u * e * my + e * e * y1);
        if (t < 1) S.raf = requestAnimationFrame(step);
        else finish();
      };
      S.raf = requestAnimationFrame(step);
    });
  }

  if (op === "click") {
    // The agent's real click lands on the page, never on the Stop pill.
    S.pill.style.pointerEvents = "none";
    setTimeout(() => (S.pill.style.pointerEvents = ""), 600);
    place(o.x, o.y);
    S.wrap.classList.add("press");
    setTimeout(() => S.wrap.classList.remove("press"), 140);
    for (const cls of ["ring", "ring two", "dot"]) {
      const r = document.createElement("span");
      r.className = cls;
      r.style.setProperty("--x", `${o.x}px`);
      r.style.setProperty("--y", `${o.y}px`);
      if (o.button === "right") r.style.borderStyle = "dashed";
      S.fx.append(r);
      setTimeout(() => r.remove(), 900);
    }
    return true;
  }
  return false;
}
