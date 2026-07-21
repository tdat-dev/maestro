// Recent-folder chips on Home. Split from main.ts; clicking a chip opens the
// wizard via an injected handler so this module doesn't import back into main.

let onOpen: (dir?: string) => void = () => {};
export function configureRecents(deps: { openWizard: (dir?: string) => void }): void {
  onOpen = deps.openWizard;
}

const RECENT_KEY = "maestro.recent";

export function getRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function addRecent(dir: string): void {
  if (!dir) return;
  const list = [dir, ...getRecents().filter((d) => d !== dir)].slice(0, 6);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  renderRecents();
}

export function renderRecents(): void {
  const wrap = document.getElementById("recents");
  const list = document.getElementById("recentsList");
  if (!wrap || !list) return;
  const r = getRecents();
  if (r.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  list.replaceChildren();
  for (const dir of r) {
    const b = document.createElement("button");
    b.className = "recent-chip";
    b.title = dir;
    b.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>${dir}</span>`;
    b.addEventListener("click", () => onOpen(dir));
    list.appendChild(b);
  }
}
