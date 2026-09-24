// Notification card over the agent list, bottom left (clear of the stage's
// header and composer) — the mockup's #hint. `topNote(msg, ms)` fades a
// short message in and out; used for the first-run tip and the Tidy / background
// confirmations. Self-contained: injects its own markup + style, no app imports.

const STYLE = `
.hint{position:fixed;left:24px;bottom:calc(var(--ib-dock-h, 84px) + 12px);z-index:180;display:block;
  width:max-content;max-width:min(calc(var(--ib-q, 320px) - 48px), calc(100vw - 48px));font-size:13px;line-height:1.5;color:var(--text);background:var(--surface-2);
  border:0;box-shadow:0 18px 40px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.1);padding:10px 14px;border-radius:14px;
  opacity:0;visibility:hidden;transform:translateY(8px);pointer-events:none;
  transition:opacity .28s,transform .28s,visibility .28s}
.hint.on{opacity:1;visibility:visible;transform:translateY(0)}
@media (prefers-reduced-motion:reduce){.hint,.hint.on{transition:opacity .2s,visibility .2s;transform:none}}
.hint b{color:var(--text)}
.hint kbd{font-family:var(--mono);font-size:11px;background:transparent;
  border:0;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);border-radius:6px;padding:1px 6px;color:var(--muted)}
`;

let hintEl: HTMLElement | null = null;
let textEl: HTMLElement | null = null;
let timer = 0;

/** Flash a message in the top-center pill for `ms`, then fade it out. */
export function topNote(msg: string, ms = 2600): void {
  if (!hintEl || !textEl) return;
  textEl.innerHTML = msg; // callers pass trusted, app-authored strings only
  hintEl.classList.add("on");
  window.clearTimeout(timer);
  timer = window.setTimeout(() => hintEl?.classList.remove("on"), ms);
}

/** Inject the pill and show the first-run tip once. Call once at startup. */
export function initHint(): void {
  if (document.getElementById("hint")) return;
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  hintEl = document.createElement("div");
  hintEl.className = "hint";
  hintEl.id = "hint";
  hintEl.setAttribute("role", "status");
  textEl = document.createElement("span");
  textEl.id = "hintText";
  hintEl.appendChild(textEl);
  document.body.appendChild(hintEl);

  // The first-run tip lives in tips.ts now (welcome), with the others.
}
