// Cosmetic topbar chrome from the approved canvas-redesign mockup: a gradient
// "M" wordmark and a pulsing "N live" indicator. Self-injected (no index.html/
// main.ts edits) so it can land without touching the existing functional
// buttons (#btnHome, #btnTidy, #btnResumeAll, #btnToggleCode). The live count
// is read via a MutationObserver on #runCount — already kept current by
// main.ts's updateCount() — so this module needs no wiring into that logic.

const STYLE_ID = "topbar-chrome-style";
const BRAND_CLASS = "tbc-brand";
const LIVE_CLASS = "tbc-live";

// Gradient-stroked "M" mark, copied verbatim from the mockup's `.brand` SVG
// (id suffixed so it can't collide with any other inline gradient on the page).
const BRAND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="url(#tbc-g)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="miter"><defs><linearGradient id="tbc-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c6f135"/><stop offset=".5" stop-color="#27b9a3"/><stop offset="1" stop-color="#0f7a3e"/></linearGradient></defs><path d="M4 19.5 6.6 7 10 12.4 12 8.4 14 12.4 17.4 7 20 19.5"/></svg>`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${BRAND_CLASS}{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;
  background:var(--surface-1);flex:none;margin-right:2px}
.${BRAND_CLASS} svg{width:16px;height:16px}
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

// First child of .topbar, ahead of .tb-left/#btnHome — decorative, non-interactive.
function injectBrand(topbar: HTMLElement): void {
  if (topbar.querySelector(`.${BRAND_CLASS}`)) return;
  const brand = document.createElement("span");
  brand.className = BRAND_CLASS;
  brand.setAttribute("aria-hidden", "true");
  brand.innerHTML = BRAND_SVG;
  topbar.insertBefore(brand, topbar.firstChild);
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

/** Injects the mockup's gradient brand mark + live-agent indicator into the
 *  existing topbar. Purely additive — does not touch any functional button. */
export function initTopbarChrome(): void {
  const topbar = document.querySelector<HTMLElement>(".topbar");
  if (!topbar) return;

  injectStyle();
  injectBrand(topbar);
  const live = injectLiveIndicator(topbar);
  if (live) wireLiveCount(live);
}
