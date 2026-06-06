import { reposUnder, repoDiff, type RepoRef } from "./ipc";
import { parseDiff, type DiffFile } from "./diff";

const enc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Provider the view calls to learn the active workspace's directory. */
let getActiveDir: () => string | null = () => null;
export function setActiveDirProvider(fn: () => string | null) {
  getActiveDir = fn;
}

const panel = () => document.getElementById("aicode");
const body = () => document.getElementById("aiDockBody");
const fleet = () => document.getElementById("aiFleet");
const repoCount = () => document.getElementById("aiRepoCount");

function renderFile(f: DiffFile): string {
  const hunks = f.hunks
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
  return `<div class="filehdr"><span class="fp">${enc(f.path)}</span><span class="fbadge">+${f.additions} −${f.deletions}</span></div>${hunks}`;
}

async function render() {
  const dir = getActiveDir();
  const f = fleet()!,
    b = body()!,
    rc = repoCount()!;
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
  for (const repo of repos) {
    const raw = await repoDiff(repo.path).catch(() => "");
    const files = parseDiff(raw);
    const add = files.reduce((n, x) => n + x.additions, 0);
    const del = files.reduce((n, x) => n + x.deletions, 0);
    const grp = document.createElement("div");
    grp.className = "repo-grp";
    grp.innerHTML = `<div class="repo-grp-h"><span class="rg-name">${enc(repo.name)}</span><span class="rg-count">${files.length} file${files.length === 1 ? "" : "s"}</span><span class="rg-meta">+${add} −${del}</span></div>`;
    f.appendChild(grp);
    if (files.length === 0) {
      b.insertAdjacentHTML("beforeend", `<div class="filehdr"><span class="fp">${enc(repo.name)} — working tree clean</span></div>`);
    } else {
      b.insertAdjacentHTML("beforeend", `<div class="filehdr" style="background:var(--surface-2)"><span class="fp"><b>${enc(repo.name)}</b></span></div>`);
      for (const file of files) b.insertAdjacentHTML("beforeend", renderFile(file));
    }
  }
}

/** Wire the topbar toggle. Call once at startup. */
export function initAiCode() {
  document.getElementById("btnAiCode")?.addEventListener("click", () => {
    const p = panel()!;
    const open = p.classList.toggle("open");
    document.getElementById("btnAiCode")?.classList.toggle("on", open);
    if (open) void render();
  });
}
