// Ctrl K for the Agent Inbox: one box to jump to any agent or run any action.
// Generic on purpose: inbox.ts hands it the items, so it knows nothing about
// panes or tasks and can be tested on its own.

export interface PaletteItem {
  group: string;
  label: string;
  /** Second, quieter line: the project and what the agent is doing. */
  sub?: string;
  /** Shortcut shown on the right ("Alt+S"). */
  keys?: string;
  /** Colour square with a letter, for agents. */
  mark?: { color: string; letter: string };
  run: () => void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Items whose words all appear in the label or second line, in their order. */
export function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((it) => {
    const hay = `${it.label} ${it.sub ?? ""} ${it.group}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

let el: HTMLElement | null = null;
let returnTo: HTMLElement | null = null;

export function paletteOpen(): boolean {
  return el !== null;
}

export function closePalette(): void {
  el?.remove();
  el = null;
  returnTo?.focus();
  returnTo = null;
}

export function openPalette(items: PaletteItem[], opts: { placeholder?: string } = {}): void {
  const hint = (opts.placeholder ?? "Jump to an agent or run a command").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  closePalette();
  returnTo = document.activeElement as HTMLElement | null;
  el = document.createElement("div");
  el.className = "inbox-modal-back pal-back";
  el.innerHTML = `
    <div class="inbox-pal" role="dialog" aria-modal="true" aria-label="${hint}">
      <div class="pal-in">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="palQ" autocomplete="off" spellcheck="false" placeholder="${hint}" role="combobox" aria-expanded="true" aria-controls="palList">
      </div>
      <div class="pal-list" id="palList" role="listbox"></div>
      <footer class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span><span><kbd>Esc</kbd> to close</span><span class="pal-n"></span></footer>
    </div>`;
  document.body.appendChild(el);
  const input = el.querySelector<HTMLInputElement>("#palQ")!;
  const list = el.querySelector<HTMLElement>(".pal-list")!;
  let shown: PaletteItem[] = items;
  let at = 0;

  const draw = () => {
    shown = filterItems(items, input.value);
    at = Math.min(at, Math.max(0, shown.length - 1));
    let group = "";
    list.innerHTML = shown.length
      ? shown.map((it, i) => {
          const head = it.group !== group ? `<div class="pal-g" role="presentation">${esc((group = it.group))}</div>` : "";
          return `${head}<div class="pal-it${i === at ? " on" : ""}" role="option" id="palIt${i}" data-i="${i}" aria-selected="${i === at}">
            ${it.mark ? `<span class="pal-mk" style="background:${esc(it.mark.color)}" aria-hidden="true">${esc(it.mark.letter)}</span>` : `<span class="pal-mk blank" aria-hidden="true"></span>`}
            <span class="pal-t">${esc(it.label)}${it.sub ? `<span class="pal-s">${esc(it.sub)}</span>` : ""}</span>
            ${it.keys ? `<kbd>${esc(it.keys)}</kbd>` : ""}</div>`;
        }).join("")
      : `<p class="pal-empty">Nothing matches “${esc(input.value)}”.</p>`;
    input.setAttribute("aria-activedescendant", shown.length ? `palIt${at}` : "");
    list.querySelector(".pal-it.on")?.scrollIntoView({ block: "nearest" });
    const n = el?.querySelector(".pal-n");
    if (n) n.textContent = `${shown.length} result${shown.length === 1 ? "" : "s"}`;
  };
  const choose = (i: number) => {
    const it = shown[i];
    if (!it) return;
    returnTo = null; // the action decides where focus goes
    closePalette();
    it.run();
  };

  input.addEventListener("input", () => { at = 0; draw(); });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePalette(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); at = Math.min(shown.length - 1, at + 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); at = Math.max(0, at - 1); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(at); }
  });
  // Hover moves the highlight by class only: rebuilding the rows under the
  // pointer would swallow the click that follows.
  list.addEventListener("mousemove", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".pal-it");
    if (!row || Number(row.dataset.i) === at) return;
    list.querySelector(".pal-it.on")?.classList.remove("on");
    row.classList.add("on");
    at = Number(row.dataset.i);
    input.setAttribute("aria-activedescendant", row.id);
  });
  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".pal-it");
    if (row) choose(Number(row.dataset.i));
  });
  el.addEventListener("mousedown", (e) => { if (e.target === el) closePalette(); });
  draw();
  input.focus();
}
