// Top-center notification pill — the mockup's #hint. `topNote(msg, ms)` fades a
// short message in and out; used for the first-run tip and the Tidy / background
// confirmations. Self-contained: injects its own markup + style, no app imports.

const STYLE = `
.hint{position:fixed;left:50%;top:54px;z-index:180;display:flex;align-items:center;gap:8px;
  font-size:11.5px;color:var(--text);background:rgba(10,13,17,.82);backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);border:1px solid var(--line-2);padding:7px 15px;border-radius:999px;
  opacity:0;visibility:hidden;transform:translateX(-50%) translateY(-8px);pointer-events:none;
  transition:opacity .28s,transform .28s,visibility .28s;box-shadow:0 12px 30px -12px rgba(0,0,0,.7)}
.hint.on{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0)}
.hint b{color:var(--text)}
.hint kbd{font-family:var(--mono);font-size:10px;background:var(--surface-2);
  border:1px solid var(--line-2);border-radius:5px;padding:1px 5px}
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
  textEl = document.createElement("span");
  textEl.id = "hintText";
  hintEl.appendChild(textEl);
  document.body.appendChild(hintEl);

  // First-run onboarding tip — shown once, then remembered.
  if (!localStorage.getItem("maestro.hintSeen")) {
    localStorage.setItem("maestro.hintSeen", "1");
    window.setTimeout(
      () => topNote("Click a terminal to zoom · drag the title bar to move · type @ to target an agent", 5200),
      900,
    );
  }
}
