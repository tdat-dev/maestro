// Cosmetic topbar chrome: a pulsing "N live" fleet indicator. Self-injected (no
// index.html/main.ts edits) so it lands without touching the functional buttons
// (#btnHome, #btnTidy, #btnResumeAll, #btnToggleCode). The count is read via a
// MutationObserver on #runCount — already kept current by main.ts's updateCount()
// — so this module needs no wiring into that logic. (The gradient "M" brand mark
// was dropped: the Home button already anchors the top-left.)

const STYLE_ID = "topbar-chrome-style";
const LIVE_CLASS = "tbc-live";

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${LIVE_CLASS}{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;
  border-radius:8px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;flex:none}
.${LIVE_CLASS} i{width:7px;height:7px;border-radius:50%;background:var(--accent);
  box-shadow:0 0 8px var(--accent);flex:none;animation:tbc-breathe 2.4s ease-in-out infinite}
.${LIVE_CLASS} b{color:var(--text)}
@keyframes tbc-breathe{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.${LIVE_CLASS} i{animation:none}}
`;
  document.head.appendChild(style);
}

// Compact "N live" indicator dropped into .tb-right, ahead of #btnToggleCode
// (falls back to appending if that anchor or .tb-right isn't found).
function injectLiveIndicator(topbar: HTMLElement): HTMLElement | null {
  const existing = topbar.querySelector<HTMLElement>(`.${LIVE_CLASS}`);
  if (existing) return existing;
  const right = topbar.querySelector<HTMLElement>(".tb-right");
  if (!right) return null;

  const live = document.createElement("span");
  live.className = LIVE_CLASS;
  live.innerHTML = `<i></i><b data-tbc-n>0</b> live`;

  const anchor = right.querySelector("#btnToggleCode");
  if (anchor) right.insertBefore(live, anchor);
  else right.appendChild(live);
  return live;
}

// Keep the indicator's own <b> synced from #runCount's textContent — the
// simplest live-count read that requires zero main.ts changes.
function wireLiveCount(live: HTMLElement): void {
  const src = document.getElementById("runCount");
  const dst = live.querySelector<HTMLElement>("[data-tbc-n]");
  if (!src || !dst) return;

  const sync = () => {
    dst.textContent = src.textContent || "0";
  };
  sync();

  const observer = new MutationObserver(sync);
  observer.observe(src, { childList: true, characterData: true, subtree: true });
}

/** Injects the live-agent indicator into the existing topbar. Purely additive —
 *  does not touch any functional button. */
export function initTopbarChrome(): void {
  const topbar = document.querySelector<HTMLElement>(".topbar");
  if (!topbar) return;

  injectStyle();
  const live = injectLiveIndicator(topbar);
  if (live) wireLiveCount(live);
}
