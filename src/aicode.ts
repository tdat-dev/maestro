import { reposUnder, repoDiff, type RepoRef } from "./ipc";
import { parseDiff, type DiffFile } from "./diff";

const enc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Files longer than this start collapsed so a single huge file (e.g. a new
 *  data dump surfaced by `git add -N`) can't flood the DOM. The user can expand
 *  any file, and collapse small ones, by clicking its header. */
const MAX_FILE_LINES = 600;

/** Provider the view calls to learn the active workspace's directory. */
let getActiveDir: () => string | null = () => null;
export function setActiveDirProvider(fn: () => string | null) {
  getActiveDir = fn;
}

const byId = (id: string) => document.getElementById(id);

interface RepoView {
  ref: RepoRef;
  files: DiffFile[];
  additions: number;
  deletions: number;
}

let views: RepoView[] = [];
let selected = 0;
const collapsed = new Set<string>(); // file keys "<repoIdx>:<fileIdx>" currently collapsed
const seeded = new Set<number>(); // repos whose large-file defaults have been applied

function fileLines(f: DiffFile): number {
  return f.hunks.reduce((n, h) => n + h.lines.length, 0);
}

function renderHunks(f: DiffFile): string {
  return f.hunks
    .map(
      (h) =>
        `<div class="hunk"><div class="hunk-bar"><span class="hunk-range">${enc(h.header)}</span></div>` +
        `<div class="diff">` +
        h.lines
          .map(
            (l) =>
              `<div class="dl ${l.kind === "add" ? "add" : l.kind === "del" ? "del" : ""}">` +
              `<span class="sign">${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>` +
              `<span class="code">${enc(l.text) || "&nbsp;"}</span></div>`,
          )
          .join("") +
        `</div></div>`,
    )
    .join("");
}

function renderFile(f: DiffFile, key: string): string {
  if (f.binary) {
    return (
      `<div class="filecard"><div class="filehdr"><span class="fp">${enc(f.path)}</span>` +
      `<span class="fbadge">binary</span></div></div>`
    );
  }
  const isColl = collapsed.has(key);
  const lines = fileLines(f);
  const big = lines > MAX_FILE_LINES;
  const hdr =
    `<div class="filehdr ffile" data-file="${key}" role="button" tabindex="0">` +
    `<span class="fchevron">${isColl ? "▸" : "▾"}</span>` +
    `<span class="fp">${enc(f.path)}</span>` +
    `<span class="fbadge">+${f.additions} −${f.deletions}${big ? ` · ${lines} ln` : ""}</span></div>`;
  // Collapsed files render no hunk DOM at all; hunks are added lazily on expand.
  const fbody = isColl ? "" : `<div class="fbody">${renderHunks(f)}</div>`;
  return `<div class="filecard${isColl ? " collapsed" : ""}" data-card="${key}">${hdr}${fbody}</div>`;
}

function renderRail() {
  const f = byId("aiFleet");
  if (!f) return;
  f.innerHTML = views
    .map(
      (v, i) =>
        `<div class="repo-grp"><div class="repo-grp-h${i === selected ? " sel" : ""}" data-repo="${i}" role="button" tabindex="0" style="--repo:${i % 2 ? "#27b9a3" : "#c6f135"}">` +
        `<span class="rg-name">${enc(v.ref.name)}</span>` +
        `<span class="rg-count">${v.files.length} file${v.files.length === 1 ? "" : "s"}</span>` +
        `<span class="rg-meta">+${v.additions} −${v.deletions}</span></div></div>`,
    )
    .join("");
}

function renderDock() {
  const b = byId("aiDockBody");
  if (!b) return;
  const v = views[selected];
  if (!v) {
    b.innerHTML = `<div class="filehdr"><span class="fp">No changes.</span></div>`;
    return;
  }
  if (v.files.length === 0) {
    b.innerHTML = `<div class="filehdr"><span class="fp">${enc(v.ref.name)} — working tree clean</span></div>`;
    return;
  }
  // First time we show a repo, collapse its large files by default.
  if (!seeded.has(selected)) {
    v.files.forEach((file, i) => {
      if (fileLines(file) > MAX_FILE_LINES) collapsed.add(`${selected}:${i}`);
    });
    seeded.add(selected);
  }
  b.innerHTML =
    `<div class="filehdr" style="background:var(--surface-2)"><span class="fp"><b>${enc(v.ref.name)}</b></span><span class="fbadge">+${v.additions} −${v.deletions}</span></div>` +
    v.files.map((file, i) => renderFile(file, `${selected}:${i}`)).join("");
  b.scrollTop = 0;
}

/** Toggle one file's collapsed state in place (no full re-render → keeps scroll). */
function toggleFile(key: string) {
  const card = byId("aiDockBody")?.querySelector<HTMLElement>(`.filecard[data-card="${CSS.escape(key)}"]`);
  if (!card) return;
  const isColl = !collapsed.has(key);
  if (isColl) collapsed.add(key);
  else collapsed.delete(key);
  card.classList.toggle("collapsed", isColl);
  const chev = card.querySelector(".fchevron");
  if (chev) chev.textContent = isColl ? "▸" : "▾";
  if (!isColl && !card.querySelector(".fbody")) {
    const [ri, fi] = key.split(":").map(Number);
    const file = views[ri]?.files[fi];
    if (file) card.insertAdjacentHTML("beforeend", `<div class="fbody">${renderHunks(file)}</div>`);
  }
}

async function render() {
  const dir = getActiveDir();
  const f = byId("aiFleet")!,
    b = byId("aiDockBody")!,
    rc = byId("aiRepoCount")!;
  views = [];
  selected = 0;
  collapsed.clear();
  seeded.clear();
  f.replaceChildren();
  b.replaceChildren();
  if (!dir) {
    b.innerHTML = `<div class="filehdr"><span class="fp">No workspace folder.</span></div>`;
    rc.textContent = "";
    return;
  }
  let repos: RepoRef[] = [];
  try {
    repos = await reposUnder(dir);
  } catch {
    /* git unavailable */
  }
  rc.textContent = `${repos.length} repo${repos.length === 1 ? "" : "s"}`;
  if (repos.length === 0) {
    b.innerHTML = `<div class="filehdr"><span class="fp">No git repository found under this folder.</span></div>`;
    return;
  }
  for (const ref of repos) {
    const raw = await repoDiff(ref.path).catch(() => "");
    // Drop no-op entries (mode-only / empty) that git emits with no hunks and no
    // line changes; keep real text diffs and binary files (shown with a label).
    const files = parseDiff(raw).filter((f) => f.binary || f.hunks.length > 0);
    views.push({
      ref,
      files,
      additions: files.reduce((n, x) => n + x.additions, 0),
      deletions: files.reduce((n, x) => n + x.deletions, 0),
    });
  }
  const firstChanged = views.findIndex((v) => v.files.length > 0);
  selected = firstChanged >= 0 ? firstChanged : 0;
  renderRail();
  renderDock();
}

/** Wire the topbar toggle + delegated rail/file clicks. Call once at startup. */
export function initAiCode() {
  const btn = byId("btnAiCode");
  btn?.addEventListener("click", () => {
    const p = byId("aicode")!;
    const open = p.classList.toggle("open");
    p.setAttribute("aria-hidden", open ? "false" : "true");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.classList.toggle("on", open);
    if (open) void render();
  });

  // Pick a repo from the rail → show only that repo's diff.
  byId("aiFleet")?.addEventListener("click", (e) => {
    const h = (e.target as HTMLElement).closest<HTMLElement>("[data-repo]");
    if (!h) return;
    const idx = Number(h.dataset.repo);
    if (idx === selected || Number.isNaN(idx)) return;
    selected = idx;
    renderRail();
    renderDock();
  });

  // Click a file header → collapse/expand that file.
  byId("aiDockBody")?.addEventListener("click", (e) => {
    const h = (e.target as HTMLElement).closest<HTMLElement>("[data-file]");
    if (!h) return;
    toggleFile(h.dataset.file!);
  });
}
