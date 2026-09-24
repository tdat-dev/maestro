/**
 * A right-click menu in the app's look, for any list that wants one.
 *
 * openMenu(x, y, items) shows it at the pointer (kept on screen); pick with the
 * mouse or the keyboard (arrows, Home/End, Enter, Esc, the first letter).
 * Only one is open at a time.
 */

export interface MenuItem {
  label: string;
  run: () => void;
  /** a short hint on the right, like a shortcut */
  hint?: string;
  /** red, for the one that removes something */
  danger?: boolean;
  disabled?: boolean;
  /** a divider above this item */
  sep?: boolean;
}

let menu: HTMLDivElement | null = null;
let items: MenuItem[] = [];
let active = -1;
let back: HTMLElement | null = null;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function rows(): HTMLElement[] {
  return menu ? [...menu.querySelectorAll<HTMLElement>(".cm-item")] : [];
}

function move(to: number, dir: 1 | -1): void {
  const n = items.length;
  for (let k = 0; k < n; k++) {
    const i = (to + k * dir + n * 2) % n;
    if (!items[i].disabled) { active = i; break; }
  }
  rows().forEach((r) => r.classList.toggle("on", Number(r.dataset.i) === active));
  const row = rows().find((r) => Number(r.dataset.i) === active);
  row?.focus({ preventScroll: true });
}

function pick(i: number): void {
  const it = items[i];
  if (!it || it.disabled) return;
  closeMenu(false);
  it.run();
}

function onKey(e: KeyboardEvent): void {
  switch (e.key) {
    case "ArrowDown": e.preventDefault(); move(active + 1, 1); break;
    case "ArrowUp": e.preventDefault(); move(active - 1, -1); break;
    case "Home": e.preventDefault(); move(0, 1); break;
    case "End": e.preventDefault(); move(items.length - 1, -1); break;
    case "Enter": case " ": e.preventDefault(); pick(active); break;
    case "Escape": e.preventDefault(); e.stopPropagation(); closeMenu(true); break;
    case "Tab": e.preventDefault(); closeMenu(true); break;
    default:
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const k = e.key.toLowerCase();
        const from = items.findIndex((it, i) => i > active && !it.disabled && it.label.toLowerCase().startsWith(k));
        const hit = from >= 0 ? from : items.findIndex((it) => !it.disabled && it.label.toLowerCase().startsWith(k));
        if (hit >= 0) move(hit, 1);
      }
  }
}

function outside(e: PointerEvent): void {
  if (menu?.contains(e.target as Node)) return;
  closeMenu(false);
}
const away = () => closeMenu(false);

export function openMenu(x: number, y: number, list: MenuItem[], label = "Actions"): void {
  closeMenu(false);
  back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  items = list;
  active = -1;
  menu = document.createElement("div");
  menu.className = "cm-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  menu.innerHTML = list.map((it, i) =>
    `${it.sep && i > 0 ? `<div class="cm-sep" role="separator"></div>` : ""}<button type="button" class="cm-item${it.danger ? " danger" : ""}" role="menuitem" tabindex="-1" data-i="${i}"${it.disabled ? ` aria-disabled="true"` : ""}><span>${esc(it.label)}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ""}</button>`).join("");
  document.body.appendChild(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  const top = y + h > window.innerHeight - 8 ? Math.max(8, y - h) : y;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.addEventListener("keydown", onKey);
  menu.addEventListener("click", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".cm-item");
    if (r) pick(Number(r.dataset.i));
  });
  menu.addEventListener("pointermove", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".cm-item");
    const i = r ? Number(r.dataset.i) : -1;
    if (r && i !== active && !items[i]?.disabled) move(i, 1);
  });
  menu.addEventListener("contextmenu", (e) => e.preventDefault());
  // Pressing an item must not take focus or the selection from the field it acts on.
  menu.addEventListener("mousedown", (e) => e.preventDefault());
  move(0, 1);
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", away);
  window.addEventListener("blur", away);
  window.addEventListener("wheel", away, { passive: true });
}

export function closeMenu(refocus: boolean): void {
  if (!menu) return;
  menu.remove();
  menu = null;
  items = [];
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", away);
  window.removeEventListener("blur", away);
  window.removeEventListener("wheel", away);
  if (refocus) back?.focus();
  back = null;
}

export function menuShown(): boolean { return !!menu; }

type Field = HTMLInputElement | HTMLTextAreaElement;
const TEXTY = /^(text|search|url|email|tel|password|number)$/;

/** The text field a right-click landed in, if any (terminals have their own menu). */
export function editableAt(target: EventTarget | null): Field | HTMLElement | null {
  const el = target instanceof Element ? target : null;
  if (!el || el.closest(".xterm")) return null;
  const f = el.closest<HTMLElement>("input, textarea, [contenteditable=''], [contenteditable='true']");
  if (f instanceof HTMLInputElement && !TEXTY.test(f.type)) return null;
  return f;
}

/** Cut / Copy / Paste / Select all for a text field, enabled as they apply. */
export function editMenu(f: Field | HTMLElement): MenuItem[] {
  const field = f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement ? f : null;
  const selected = field ? (field.selectionEnd ?? 0) > (field.selectionStart ?? 0) : !!window.getSelection()?.toString();
  const readOnly = field ? field.readOnly || field.disabled : false;
  const secret = field instanceof HTMLInputElement && field.type === "password";
  const selectedText = () => field ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0) : window.getSelection()?.toString() ?? "";
  const insert = (text: string) => {
    f.focus();
    if (field) {
      field.setRangeText(text, field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("insertText", false, text);
    }
  };
  return [
    { label: "Cut", hint: "Ctrl+X", disabled: !selected || readOnly || secret, run: () => {
      void navigator.clipboard.writeText(selectedText()).then(() => insert("")).catch(() => {});
    } },
    { label: "Copy", hint: "Ctrl+C", disabled: !selected || secret, run: () => { void navigator.clipboard.writeText(selectedText()).catch(() => {}); } },
    { label: "Paste", hint: "Ctrl+V", disabled: readOnly, run: () => {
      void navigator.clipboard.readText().then((t) => { if (t) insert(t); }).catch(() => {});
    } },
    { label: "Select all", hint: "Ctrl+A", sep: true, run: () => {
      f.focus();
      if (field) field.select(); else window.getSelection()?.selectAllChildren(f);
    } },
  ];
}

/** Replace the WebView's page menu (Back, Refresh, Print, Emoji, Inspect…)
 *  everywhere: text fields get the app's edit menu, the rest gets nothing.
 *  Shift+right-click still reaches it while developing. */
export function blockNativeMenu(dev = false): void {
  document.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented) return; // one of our own menus took it
    if (dev && e.shiftKey) return;
    e.preventDefault();
    const f = editableAt(e.target);
    if (f) { openMenu(e.clientX, e.clientY, editMenu(f), "Edit"); return; }
    // Selected text anywhere else (a chat answer, the help page) can be copied.
    const picked = window.getSelection()?.toString() ?? "";
    if (picked.trim()) {
      openMenu(e.clientX, e.clientY, [
        { label: "Copy", hint: "Ctrl+C", run: () => { void navigator.clipboard.writeText(picked).catch(() => {}); } },
      ], "Selection");
    }
  });
}
