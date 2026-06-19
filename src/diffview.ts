/* Diff — redesigned git review, re-homed from the old full-screen "AI Code"
 * overlay into a dock panel. Reuses the existing git IPC (reposUnder / repoDiff
 * / review* commands) and the pure diff parser. Reviews uncommitted changes in
 * the active workspace's folder (or its sub-repos) and offers commit / discard /
 * merge for isolated agent worktrees. See dock.ts. */

import {
  reposUnder,
  repoDiff,
  reviewRepoInfo,
  reviewCommit,
  reviewMerge,
  reviewDiscard,
  confirmDialog,
  type RepoRef,
  type RepoInfo,
} from "./ipc";
import { parseDiff, type DiffFile } from "./diff";
import type { DockContext } from "./dockstore";

const MAX_FILE_LINES = 600; // bigger files start collapsed so one dump can't flood the DOM

const enc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function el(tag: string, cls?: string, html?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function fileLines(f: DiffFile): number {
  return f.hunks.reduce((n, h) => n + h.lines.length, 0);
}

const REFRESH_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5"/></svg>';

export function createDiffView() {
  let ctx: DockContext | null = null;
  let root: HTMLElement | null = null;
  let actions: HTMLElement | null = null;

  let repos: RepoRef[] = [];
  let selected: string | null = null; // selected repo root
  let files: DiffFile[] = [];
  let info: RepoInfo | null = null;
  let committed = false; // a commit happened this session → Merge becomes meaningful
  let busy = false;
  let loaded = false;
  const collapsed = new Set<string>();

  function setStatus(msg: string, kind: "" | "ok" | "err" | "busy" = "") {
    const s = root?.querySelector(".dv-status");
    if (s) {
      s.textContent = msg;
      s.className = `dv-status ${kind}`;
    }
  }

  async function refresh() {
    if (!ctx?.dir) {
      repos = [];
      selected = null;
      files = [];
      info = null;
      render();
      return;
    }
    busy = true;
    setStatus("Scanning…", "busy");
    try {
      repos = await reposUnder(ctx.dir);
      if (!repos.length) {
        selected = null;
        files = [];
        info = null;
        render();
        return;
      }
      if (!selected || !repos.some((r) => r.path === selected)) {
        selected = repos[0].path;
      }
      await loadRepo(selected);
    } catch (err) {
      setStatus(`Could not read repo: ${String(err)}`, "err");
    } finally {
      busy = false;
    }
  }

  async function loadRepo(repoRoot: string) {
    selected = repoRoot;
    const [raw, ri] = await Promise.all([
      repoDiff(repoRoot),
      reviewRepoInfo(repoRoot).catch(() => null),
    ]);
    files = parseDiff(raw);
    info = ri;
    // seed: collapse big files for this repo once
    files.forEach((f, i) => {
      if (fileLines(f) > MAX_FILE_LINES) collapsed.add(`${i}`);
    });
    render();
  }

  function summary() {
    const adds = files.reduce((n, f) => n + f.additions, 0);
    const dels = files.reduce((n, f) => n + f.deletions, 0);
    return { adds, dels, count: files.length };
  }

  function hunksHTML(f: DiffFile): string {
    return f.hunks
      .map(
        (h) =>
          `<div class="dv-hunk"><div class="dv-hunk-h">${enc(h.header)}</div>` +
          h.lines
            .map(
              (l) =>
                `<div class="dv-dl ${l.kind === "add" ? "add" : l.kind === "del" ? "del" : ""}">` +
                `<span class="dv-sign">${l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>` +
                `<span class="dv-code">${enc(l.text) || "&nbsp;"}</span></div>`,
            )
            .join("") +
          `</div>`,
      )
      .join("");
  }

  function fileCard(f: DiffFile, key: string): HTMLElement {
    const isColl = collapsed.has(key);
    const lines = fileLines(f);
    const big = lines > MAX_FILE_LINES;
    const card = el("div", `dv-file${isColl ? " collapsed" : ""}`);
    if (f.binary) {
      card.innerHTML = `<header class="dv-file-h"><span class="dv-chev"> </span><span class="dv-path">${enc(f.path)}</span><span class="dv-badge">binary</span></header>`;
      return card;
    }
    card.innerHTML =
      `<header class="dv-file-h" data-file="${key}" role="button" tabindex="0">` +
      `<span class="dv-chev">${isColl ? "▸" : "▾"}</span>` +
      `<span class="dv-path">${enc(f.path)}</span>` +
      `<span class="dv-counts"><span class="dv-a">+${f.additions}</span> <span class="dv-d">−${f.deletions}</span>${big ? `<span class="dv-ln">${lines} ln</span>` : ""}</span>` +
      `</header>` +
      (isColl ? "" : `<div class="dv-file-b">${hunksHTML(f)}</div>`);
    card.querySelector("[data-file]")?.addEventListener("click", () => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      render();
    });
    return card;
  }

  // ---- write ops ----
  async function onCommit() {
    if (busy || !selected) return;
    const input = root?.querySelector<HTMLInputElement>(".dv-msg");
    const msg = input?.value.trim();
    if (!msg) {
      input?.focus();
      setStatus("Type a commit message first.", "err");
      return;
    }
    busy = true;
    setStatus("Committing…", "busy");
    try {
      const out = await reviewCommit(selected, msg);
      committed = true;
      if (input) input.value = "";
      setStatus(out || "Committed.", "ok");
      await loadRepo(selected);
    } catch (err) {
      setStatus(`Commit failed: ${String(err)}`, "err");
    } finally {
      busy = false;
    }
  }

  async function onDiscard() {
    if (busy || !selected) return;
    const ok = await confirmDialog(
      "Discard all uncommitted changes in this folder? This cannot be undone.",
      "Discard changes",
    );
    if (!ok) return;
    busy = true;
    setStatus("Discarding…", "busy");
    try {
      await reviewDiscard(selected);
      setStatus("Discarded.", "ok");
      await loadRepo(selected);
    } catch (err) {
      setStatus(`Discard failed: ${String(err)}`, "err");
    } finally {
      busy = false;
    }
  }

  async function onMerge() {
    if (busy || !selected || !info?.isWorktree || !info.branch) return;
    const ok = await confirmDialog(
      `Merge "${info.branch}" into the repo's current branch?`,
      "Merge to main",
    );
    if (!ok) return;
    busy = true;
    setStatus("Merging…", "busy");
    try {
      const out = await reviewMerge(info.mainRoot || selected, info.branch);
      setStatus(out || "Merged.", "ok");
      await loadRepo(selected);
    } catch (err) {
      setStatus(`Merge failed: ${String(err)}`, "err");
    } finally {
      busy = false;
    }
  }

  function render() {
    if (!root) return;
    root.replaceChildren();

    if (!ctx?.dir) {
      root.appendChild(emptyState("Open a folder workspace to review its git changes."));
      return;
    }
    if (!repos.length) {
      root.appendChild(emptyState("No git repository found in this folder."));
      return;
    }

    // repo selector (only when >1 repo under the folder)
    if (repos.length > 1) {
      const sel = el("div", "dv-repos");
      repos.forEach((r) => {
        const chip = el("button", `dv-repo${r.path === selected ? " on" : ""}`, enc(r.name));
        chip.addEventListener("click", () => {
          if (r.path !== selected && !busy) void loadRepo(r.path);
        });
        sel.appendChild(chip);
      });
      root.appendChild(sel);
    }

    const { adds, dels, count } = summary();
    const bar = el("div", "dv-summary");
    bar.innerHTML =
      `<span class="dv-files-n">${count} file${count === 1 ? "" : "s"}</span>` +
      `<span class="dv-a">+${adds}</span><span class="dv-d">−${dels}</span>` +
      (info?.branch
        ? `<span class="dv-branch" title="Branch"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="8" r="3"/><path d="M6 9v6m12-4a6 6 0 0 1-6 6H9"/></svg>${enc(info.branch)}${info.isWorktree ? '<em class="dv-wt">worktree</em>' : ""}</span>`
        : "");
    root.appendChild(bar);

    const list = el("div", "dv-list");
    if (!files.length) {
      list.appendChild(emptyState("No uncommitted changes. This folder is clean.", true));
    } else {
      files.forEach((f, i) => list.appendChild(fileCard(f, `${i}`)));
    }
    root.appendChild(list);

    // action footer
    const foot = el("footer", "dv-foot");
    foot.innerHTML =
      `<div class="dv-status"></div>` +
      `<div class="dv-compose">` +
      `<input class="dv-msg" placeholder="Commit message…" spellcheck="false" ${files.length ? "" : "disabled"}>` +
      `</div>` +
      `<div class="dv-btns">` +
      `<button class="dv-btn" data-discard ${files.length ? "" : "disabled"}>Discard</button>` +
      `<button class="dv-btn primary" data-commit ${files.length ? "" : "disabled"}>Commit</button>` +
      (info?.isWorktree
        ? `<button class="dv-btn merge" data-merge ${committed || !files.length ? "" : "disabled"} title="Merge this branch into the repo's current branch">Merge</button>`
        : "") +
      `</div>`;
    foot.querySelector("[data-commit]")?.addEventListener("click", () => void onCommit());
    foot.querySelector("[data-discard]")?.addEventListener("click", () => void onDiscard());
    foot.querySelector("[data-merge]")?.addEventListener("click", () => void onMerge());
    foot.querySelector<HTMLInputElement>(".dv-msg")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void onCommit();
    });
    root.appendChild(foot);
  }

  function emptyState(msg: string, clean = false): HTMLElement {
    return el(
      "div",
      `dv-empty${clean ? " clean" : ""}`,
      `<span class="dv-empty-ic"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="8" r="3"/><path d="M6 9v6m12-4a6 6 0 0 1-6 6H9"/></svg></span><p>${enc(msg)}</p>`,
    );
  }

  return {
    mount(body: HTMLElement, actionsSlot: HTMLElement) {
      root = el("div", "dv-root");
      body.appendChild(root);
      actions = actionsSlot;
      const refreshBtn = el("button", "dock-act", REFRESH_SVG);
      refreshBtn.title = "Refresh diff";
      refreshBtn.setAttribute("aria-label", "Refresh diff");
      refreshBtn.addEventListener("click", () => void refresh());
      actions.appendChild(refreshBtn);
      render();
    },
    setContext(next: DockContext | null) {
      const changed = next?.key !== ctx?.key;
      ctx = next;
      if (changed) {
        selected = null;
        files = [];
        info = null;
        committed = false;
        collapsed.clear();
        loaded = false;
        // If the diff panel is open when the workspace switches, re-fetch right
        // away; otherwise wait for the next show().
        if (root && root.offsetParent !== null) {
          loaded = true;
          void refresh();
        } else {
          render();
        }
      }
    },
    show() {
      // fetch on first open for the current context; refresh button handles re-fetch
      if (!loaded) {
        loaded = true;
        void refresh();
      }
    },
  };
}
