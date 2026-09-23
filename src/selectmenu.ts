/**
 * The app's own drop-down for every <select>.
 *
 * The native popup is drawn by Windows (grey highlight, square corners, system
 * font) and cannot be styled, so each select is kept as the hidden source of
 * truth and a button plus a floating list stand in for it. Code that reads
 * `select.value` or listens for `change` keeps working untouched.
 *
 * Options can carry two hints for the list:
 *   data-sub="…"  a quieter second line (a folder's path)
 *   data-note="…" a word on the right, shown for disabled rows ("Not installed")
 *   data-sep      a divider above the row
 */

const CHEVRON = `<svg class="sm-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 3.75 5 6.25l2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHECK = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const done = new WeakMap<HTMLSelectElement, HTMLButtonElement>();
let pop: HTMLDivElement | null = null;
let owner: HTMLSelectElement | null = null;
let active = -1;
let typed = "";
let typedAt = 0;
let uid = 0;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** The words that name a select: its aria-label, or the label around or for it. */
function nameOf(sel: HTMLSelectElement): string {
  const aria = sel.getAttribute("aria-label");
  if (aria) return aria;
  const wrap = sel.closest("label");
  const sr = wrap?.querySelector(".ia-sr");
  if (sr?.textContent) return sr.textContent.trim();
  if (sel.id) {
    const lab = document.querySelector(`label[for="${CSS.escape(sel.id)}"]`);
    if (lab?.textContent) return lab.textContent.trim();
  }
  return "";
}

/** Put the chosen option's text on the button. */
export function syncSelect(sel: HTMLSelectElement): void {
  const btn = done.get(sel);
  if (!btn) return;
  const opt = sel.options[sel.selectedIndex];
  const label = btn.querySelector(".sm-val");
  if (label) label.textContent = opt?.textContent?.trim() ?? "";
  btn.disabled = sel.disabled;
  if (owner === sel) renderList();
}

/** Setting .value or .selectedIndex in code redraws the button too. */
function watchValue(sel: HTMLSelectElement): void {
  for (const key of ["value", "selectedIndex"] as const) {
    let d: PropertyDescriptor | undefined;
    for (let p = Object.getPrototypeOf(sel); p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, key);
    if (!d?.get || !d.set) continue;
    Object.defineProperty(sel, key, {
      configurable: true,
      get() { return d.get!.call(this); },
      set(v) { d.set!.call(this, v); syncSelect(sel); },
    });
  }
}

export function enhanceSelect(sel: HTMLSelectElement): HTMLButtonElement {
  const had = done.get(sel);
  if (had) return had;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `sm-btn ${sel.className}`.trim();
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  const name = nameOf(sel);
  if (name) btn.setAttribute("aria-label", name);
  if (sel.title) btn.title = sel.title;
  btn.innerHTML = `<span class="sm-val"></span>${CHEVRON}`;
  sel.classList.add("sm-native");
  sel.tabIndex = -1;
  sel.setAttribute("aria-hidden", "true");
  sel.after(btn);
  done.set(sel, btn);
  watchValue(sel);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    if (owner === sel) close(true); else open(sel);
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(sel);
    }
  });
  // A <label for> pointed at the hidden select now opens the button's list.
  if (sel.id) {
    document.querySelectorAll<HTMLLabelElement>(`label[for="${CSS.escape(sel.id)}"]`).forEach((l) =>
      l.addEventListener("click", (e) => { e.preventDefault(); btn.focus(); }));
  }
  new MutationObserver(() => syncSelect(sel)).observe(sel, { childList: true, subtree: true, attributes: true, characterData: true });
  sel.addEventListener("change", () => syncSelect(sel));
  syncSelect(sel);
  return btn;
}

/** Enhance every select under a root; safe to call again after new markup. */
export function enhanceSelects(root: ParentNode = document): void {
  root.querySelectorAll<HTMLSelectElement>("select:not([multiple]):not([data-native])").forEach(enhanceSelect);
}

function rows(): HTMLElement[] {
  return pop ? [...pop.querySelectorAll<HTMLElement>(".sm-opt")] : [];
}

function renderList(): void {
  if (!pop || !owner) return;
  const cur = owner.selectedIndex;
  pop.innerHTML = [...owner.options].map((o, i) => {
    const sub = o.dataset.sub ? `<span class="sm-sub">${esc(o.dataset.sub)}</span>` : "";
    const note = o.disabled && o.dataset.note ? `<span class="sm-note">${esc(o.dataset.note)}</span>` : "";
    return `${o.dataset.sep !== undefined && i > 0 ? `<div class="sm-sep" role="separator"></div>` : ""}<div class="sm-opt${i === active ? " on" : ""}" role="option" id="sm-o${i}" data-i="${i}"
      aria-selected="${i === cur}"${o.disabled ? ` aria-disabled="true"` : ""}>
      <span class="sm-tick">${i === cur ? CHECK : ""}</span><span class="sm-txt"><span class="sm-lab">${esc(o.textContent?.trim() ?? "")}</span>${sub}</span>${note}</div>`;
  }).join("");
  if (active >= 0) pop.setAttribute("aria-activedescendant", `sm-o${active}`);
}

function place(btn: HTMLElement): void {
  if (!pop) return;
  const r = btn.getBoundingClientRect();
  const gap = 6;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  pop.style.minWidth = `${Math.max(r.width, 180)}px`;
  pop.style.maxHeight = "";
  const h = pop.offsetHeight;
  const below = vh - r.bottom - gap - 12;
  const above = r.top - gap - 12;
  const up = h > below && above > below;
  const room = up ? above : below;
  if (h > room) pop.style.maxHeight = `${Math.max(room, 120)}px`;
  const top = up ? r.top - gap - Math.min(h, room) : r.bottom + gap;
  const left = Math.min(Math.max(12, r.left), vw - pop.offsetWidth - 12);
  pop.style.top = `${Math.round(top)}px`;
  pop.style.left = `${Math.round(Math.max(12, left))}px`;
  pop.dataset.side = up ? "up" : "down";
}

function move(to: number, dir: 1 | -1): void {
  if (!owner) return;
  const n = owner.options.length;
  for (let k = 0; k < n; k++) {
    const i = (to + k * dir + n * 2) % n;
    if (!owner.options[i].disabled) { active = i; break; }
  }
  rows().forEach((r) => r.classList.toggle("on", Number(r.dataset.i) === active));
  pop?.setAttribute("aria-activedescendant", `sm-o${active}`);
  reveal();
}

/** Scroll the list, and only the list, so the active row is in view. */
function reveal(): void {
  const row = pop?.querySelector<HTMLElement>(`#sm-o${active}`);
  if (!pop || !row) return;
  if (row.offsetTop < pop.scrollTop) pop.scrollTop = row.offsetTop - 5;
  else if (row.offsetTop + row.offsetHeight > pop.scrollTop + pop.clientHeight) pop.scrollTop = row.offsetTop + row.offsetHeight - pop.clientHeight + 5;
}

function choose(i: number): void {
  const sel = owner;
  if (!sel) return;
  const o = sel.options[i];
  if (!o || o.disabled) return;
  const changed = sel.selectedIndex !== i;
  sel.selectedIndex = i;
  close(true);
  if (changed) {
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function onKey(e: KeyboardEvent): void {
  if (!owner) return;
  const n = owner.options.length;
  switch (e.key) {
    case "ArrowDown": e.preventDefault(); move(active + 1, 1); break;
    case "ArrowUp": e.preventDefault(); move(active - 1, -1); break;
    case "Home": e.preventDefault(); move(0, 1); break;
    case "End": e.preventDefault(); move(n - 1, -1); break;
    case "Enter": case " ": e.preventDefault(); choose(active); break;
    case "Escape": e.preventDefault(); e.stopPropagation(); close(true); break;
    case "Tab": close(false); break;
    default:
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = Date.now();
        typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
        typedAt = now;
        const opts = [...owner.options];
        const hit = opts.findIndex((o, i) => i > active && !o.disabled && o.text.toLowerCase().startsWith(typed));
        const any = hit >= 0 ? hit : opts.findIndex((o) => !o.disabled && o.text.toLowerCase().startsWith(typed));
        if (any >= 0) move(any, 1);
      }
  }
}

function outside(e: PointerEvent): void {
  const t = e.target as Node;
  if (pop?.contains(t)) return;
  if (owner && done.get(owner)?.contains(t)) return;
  close(false);
}

function onViewport(e: Event): void {
  // Only a scroll that moves the button carries the list away from it.
  if (e.type === "scroll") {
    const t = e.target;
    const btn = owner ? done.get(owner) : null;
    if (!btn || !(t instanceof Node) || pop?.contains(t)) return;
    if (t !== document && !t.contains(btn)) return;
  }
  close(false);
}

export function open(sel: HTMLSelectElement): void {
  const btn = done.get(sel);
  if (!btn || sel.disabled) return;
  if (owner) close(false);
  owner = sel;
  active = sel.selectedIndex >= 0 && !sel.options[sel.selectedIndex]?.disabled ? sel.selectedIndex : -1;
  pop = document.createElement("div");
  pop.className = "sm-pop";
  pop.setAttribute("role", "listbox");
  pop.id = `sm-pop${++uid}`;
  pop.tabIndex = -1;
  const name = btn.getAttribute("aria-label");
  if (name) pop.setAttribute("aria-label", name);
  document.body.appendChild(pop);
  renderList();
  if (active < 0) move(0, 1);
  place(btn);
  btn.setAttribute("aria-expanded", "true");
  btn.setAttribute("aria-controls", pop.id);
  btn.classList.add("open");
  pop.addEventListener("keydown", onKey);
  pop.addEventListener("pointermove", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".sm-opt");
    const i = r ? Number(r.dataset.i) : -1;
    if (r && i !== active && r.getAttribute("aria-disabled") !== "true") move(i, 1);
  });
  pop.addEventListener("click", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".sm-opt");
    if (r) choose(Number(r.dataset.i));
  });
  pop.focus({ preventScroll: true });
  reveal();
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onViewport, true);
  window.addEventListener("blur", onViewport);
}

export function close(refocus: boolean): void {
  const sel = owner;
  const btn = sel ? done.get(sel) : null;
  pop?.remove();
  pop = null;
  owner = null;
  active = -1;
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", onViewport);
  window.removeEventListener("scroll", onViewport, true);
  window.removeEventListener("blur", onViewport);
  if (btn) {
    btn.setAttribute("aria-expanded", "false");
    btn.removeAttribute("aria-controls");
    btn.classList.remove("open");
    if (refocus) btn.focus();
  }
}

export function menuOpen(): boolean { return !!pop; }
