// The workspace explorer. A live, VS Code-shaped file tree: state (expanded /
// selected / cursor) lives in plain sets and the visible rows are rendered as
// one flat list, so multi-select, keyboard navigation and a filesystem watcher
// can all drive the same view. Directory contents load lazily and are cached;
// the backend watcher (`fs-changed`) reloads exactly the directories that
// changed, so anything an agent writes on disk appears without a manual poke.
import {
  fsReadDir,
  fsCreateFile,
  fsCreateDir,
  fsRename,
  fsDelete,
  fsCopy,
  fsMove,
  fsTrash,
  fsReveal,
  fsOpenExternal,
  watchStart,
  watchStop,
  onFsChanged,
  confirmDialog,
  type FsEntry,
} from "./ipc";
import {
  filterEntries,
  sortEntries,
  flattenTree,
  applySelection,
  parentOf,
  parentsOf,
  topLevelOnly,
  isInside,
  iconForFile,
  type TreeRow,
  type SelectMode,
} from "./codepanel";
import { highlightPaneAt, dropPathsAtPoint, clearPaneHighlight } from "./bridges";

interface FileTreeOpts {
  host: HTMLElement;
  onOpenFile: (relPath: string) => void;
  /** A tracked file moved — the editor should follow it. */
  onPathChanged?: (from: string, to: string) => void;
  /** Paths that no longer exist — the editor should let go of them. */
  onPathsGone?: (rels: string[]) => void;
  /** Open a terminal in this absolute directory. */
  onOpenTerminal?: (absDir: string) => void;
}

export interface FileTreeApi {
  setRoot(dir: string | null): void;
  /** Expand to and select `rel` (used to follow the file open in the editor). */
  reveal(rel: string): Promise<void>;
  refresh(): Promise<void>;
}

/* ---------------- icons ---------------- */

const svg = (body: string, cls: string) =>
  `<svg class="tw-ic ${cls}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const CHEVRON =
  '<svg class="tw-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

const FOLDER =
  '<path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.8 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
const FOLDER_OPEN =
  '<path d="M4 19V7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L12.8 7H18a2 2 0 0 1 2 2v1.4"/><path d="M4 19l2.4-6.8A2 2 0 0 1 8.3 10.8H22l-2.4 6.8A2 2 0 0 1 17.7 19z"/>';

const GLYPHS: Record<string, string> = {
  file: '<path d="M14 3v4a1 1 0 0 0 1 1h4M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>',
  doc: '<path d="M14 3v4a1 1 0 0 0 1 1h4M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M9 13h6M9 17h4"/>',
  code: '<path d="m9 18-6-6 6-6M15 6l6 6-6 6"/>',
  markup: '<path d="m18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16"/>',
  braces:
    '<path d="M8 3H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  gear: '<path d="M4 7h5M15 7h5M4 17h9M19 17h1"/><circle cx="12" cy="7" r="2.4"/><circle cx="16" cy="17" r="2.4"/>',
  term: '<path d="m5 8 4 4-4 4M13 16h6"/><rect x="2" y="3" width="20" height="18" rx="2"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  git: '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="9" r="2.6"/><path d="M6 8.6v6.8M18 11.6c0 3-2.4 4.4-5 4.4H8.6"/>',
  db: '<path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
};

function entryIcon(name: string, isDir: boolean, open: boolean): string {
  if (isDir) return svg(open ? FOLDER_OPEN : FOLDER, "tw-ic-dir");
  const { glyph, color } = iconForFile(name);
  return svg(GLYPHS[glyph] ?? GLYPHS.file, `tw-c-${color}`);
}

interface MenuItem {
  label?: string;
  hint?: string;
  danger?: boolean;
  sep?: boolean;
  action?: () => void;
}

/** Files scanned at most when the filter box searches unopened folders. */
const SEARCH_VISIT_CAP = 12000;
const SEARCH_HIT_CAP = 300;

export function initFileTree(opts: FileTreeOpts): FileTreeApi {
  const { host, onOpenFile } = opts;
  const toolbar = document.getElementById("cpTools");
  const filterInput = document.getElementById("cpFilter") as HTMLInputElement | null;

  let root: string | null = null;
  let showHidden = localStorage.getItem("maestro.tree.hidden") === "1";

  /** Loaded directory listings, keyed by relative dir ("" = root). */
  const children = new Map<string, FsEntry[]>();
  const expanded = new Set<string>();
  let selected = new Set<string>();
  let anchor: string | null = null;
  let cursor: string | null = null;
  let rows: TreeRow[] = [];

  let clipboard: { rels: string[]; cut: boolean } | null = null;
  let query = "";
  let results: TreeRow[] | null = null; // flat filter results, null = normal tree
  /** An inline input owns the DOM right now — re-renders would destroy it. */
  let editing = false;
  let renderQueued = false;

  const joinRel = (rel: string, name: string) => (rel ? `${rel}\\${name}` : name);
  const abs = (rel: string) => (rel ? `${root}\\${rel}` : `${root}`);
  const rowOf = (rel: string) => rows.find((r) => r.rel === rel) ?? null;

  /* ---------------- persistence ---------------- */

  const expandKey = () => `maestro.tree.open:${root ?? ""}`;
  const saveExpanded = () => {
    if (root) localStorage.setItem(expandKey(), JSON.stringify([...expanded].slice(0, 400)));
  };
  const loadExpanded = (): string[] => {
    if (!root) return [];
    try {
      const v = JSON.parse(localStorage.getItem(expandKey()) ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };

  /* ---------------- context menu (singleton) ---------------- */

  let menuEl: HTMLElement | null = null;
  const closeMenu = () => {
    menuEl?.remove();
    menuEl = null;
  };
  function showMenu(x: number, y: number, items: MenuItem[]) {
    closeMenu();
    const m = document.createElement("div");
    m.className = "ctx-menu";
    for (const it of items) {
      if (it.sep) {
        const s = document.createElement("div");
        s.className = "ctx-sep";
        m.appendChild(s);
        continue;
      }
      const b = document.createElement("button");
      b.className = "ctx-item" + (it.danger ? " danger" : "");
      const label = document.createElement("span");
      label.textContent = it.label ?? "";
      b.appendChild(label);
      if (it.hint) {
        const k = document.createElement("kbd");
        k.className = "ctx-key";
        k.textContent = it.hint;
        b.appendChild(k);
      }
      b.addEventListener("click", () => {
        closeMenu();
        it.action?.();
      });
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    m.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
    menuEl = m;
  }
  document.addEventListener("pointerdown", (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  /* ---------------- loading + rendering ---------------- */

  async function load(rel: string): Promise<void> {
    if (!root) return;
    try {
      children.set(rel, await fsReadDir(root, rel || "."));
    } catch {
      children.set(rel, []);
    }
  }

  /** Reload the directories that changed, then repaint once. */
  async function reload(dirs: string[]): Promise<void> {
    const known = dirs.filter((d) => children.has(d));
    await Promise.all(known.map((d) => load(d)));
    if (known.length) render();
  }

  function render(): void {
    if (editing) {
      renderQueued = true;
      return;
    }
    renderQueued = false;
    rows = results ?? flattenTree(children, expanded, showHidden);
    const scroll = host.scrollTop;
    const frag = document.createDocumentFragment();

    if (!root) {
      host.innerHTML = `<div class="tw-msg">No folder for this workspace</div>`;
      return;
    }
    if (!rows.length) {
      host.innerHTML = results
        ? `<div class="tw-msg">No file matches “${query}”</div>`
        : `<div class="tw-msg">This folder is empty</div>`;
      return;
    }
    for (const r of rows) frag.appendChild(rowEl(r));
    host.replaceChildren(frag);
    host.scrollTop = scroll;
  }

  function rowEl(r: TreeRow): HTMLElement {
    const el = document.createElement("div");
    const open = r.isDir && expanded.has(r.rel);
    el.className =
      "tw-row" +
      (r.isDir ? " tw-dir" : " tw-file") +
      (open ? " open" : "") +
      (selected.has(r.rel) ? " sel" : "") +
      (cursor === r.rel ? " cur" : "") +
      (clipboard?.cut && clipboard.rels.includes(r.rel) ? " cut" : "");
    el.dataset.rel = r.rel;
    el.style.setProperty("--d", String(r.depth));
    el.innerHTML =
      (r.isDir ? CHEVRON : `<span class="tw-chev tw-spacer"></span>`) +
      entryIcon(r.name, r.isDir, open) +
      `<span class="tw-name"></span>`;
    el.querySelector<HTMLElement>(".tw-name")!.textContent = r.name;
    // In filter mode every hit is depth 0, so show where it actually lives.
    if (results) {
      const dir = parentOf(r.rel);
      if (dir) {
        const p = document.createElement("span");
        p.className = "tw-path";
        p.textContent = dir;
        el.appendChild(p);
      }
    }
    return el;
  }

  /* ---------------- selection ---------------- */

  function select(rel: string, mode: SelectMode): void {
    const order = rows.map((r) => r.rel);
    const next = applySelection(order, selected, anchor, rel, mode);
    selected = next.selected;
    anchor = next.anchor;
    cursor = rel;
    render();
  }

  /** What an action applies to: the selection, or the row under the cursor. */
  function targets(): string[] {
    if (selected.size) return topLevelOnly([...selected]);
    return cursor ? [cursor] : [];
  }

  /** The folder new entries / pastes land in: the selected folder, or the
   *  parent of the selected file (VS Code's rule). */
  function contextDir(): string {
    const rel = cursor ?? [...selected][0] ?? "";
    if (!rel) return "";
    const r = rowOf(rel);
    return r?.isDir ? rel : parentOf(rel);
  }

  /* ---------------- expand / collapse ---------------- */

  async function setOpen(rel: string, open: boolean): Promise<void> {
    if (open) {
      expanded.add(rel);
      if (!children.has(rel)) await load(rel);
    } else {
      expanded.delete(rel);
    }
    saveExpanded();
    render();
  }

  const toggleDir = (rel: string) => setOpen(rel, !expanded.has(rel));

  function collapseAll(): void {
    expanded.clear();
    saveExpanded();
    render();
  }

  /** Expand every ancestor of `rel` so the row becomes visible. */
  async function expandTo(rel: string): Promise<void> {
    const chain: string[] = [];
    for (let p = parentOf(rel); p; p = parentOf(p)) chain.unshift(p);
    for (const dir of chain) {
      expanded.add(dir);
      if (!children.has(dir)) await load(dir);
    }
    saveExpanded();
  }

  async function reveal(rel: string): Promise<void> {
    if (!root || !rel) return;
    clearFilter();
    await expandTo(rel);
    selected = new Set([rel]);
    anchor = rel;
    cursor = rel;
    render();
    host
      .querySelector<HTMLElement>(`[data-rel="${CSS.escape(rel)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  /* ---------------- inline create / rename ---------------- */

  /** Put an input row into the DOM without a re-render (a render would blow the
   *  input away mid-typing) and resolve with the typed name, or null. */
  function inlineInput(
    anchorEl: HTMLElement | null,
    depth: number,
    kind: "file" | "dir",
    initial: string,
  ): Promise<string | null> {
    editing = true;
    const wrap = document.createElement("div");
    wrap.className = "tw-row tw-input-row";
    wrap.style.setProperty("--d", String(depth));
    wrap.innerHTML =
      `<span class="tw-chev tw-spacer"></span>` + entryIcon(initial || "x", kind === "dir", false);
    const input = document.createElement("input");
    input.className = "tw-input";
    input.spellcheck = false;
    input.value = initial;
    input.placeholder = kind === "file" ? "new-file.ts" : "new-folder";
    wrap.appendChild(input);
    if (anchorEl) anchorEl.after(wrap);
    else host.prepend(wrap);
    input.focus();
    // Preselect the stem so typing replaces the name but keeps the extension.
    const dot = initial.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();

    return new Promise((resolve) => {
      let done = false;
      const finish = (commit: boolean) => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        wrap.remove();
        editing = false;
        if (renderQueued) render();
        resolve(commit && v ? v : null);
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // the tree's own key handling must not fire
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(true));
    });
  }

  async function newEntry(parentRel: string, kind: "file" | "dir"): Promise<void> {
    if (!root) return;
    clearFilter();
    if (parentRel) {
      await setOpen(parentRel, true);
    }
    const parentRow = parentRel ? rowOf(parentRel) : null;
    const anchorEl = parentRel
      ? host.querySelector<HTMLElement>(`[data-rel="${CSS.escape(parentRel)}"]`)
      : null;
    const depth = parentRow ? parentRow.depth + 1 : 0;
    const name = await inlineInput(anchorEl, depth, kind, "");
    if (!name) return;
    const rel = joinRel(parentRel, name);
    try {
      if (kind === "file") await fsCreateFile(root, rel);
      else await fsCreateDir(root, rel);
    } catch (e) {
      toast(`Could not create “${name}” — ${errText(e)}`);
      return;
    }
    await load(parentRel);
    cursor = rel;
    selected = new Set([rel]);
    render();
    if (kind === "file") onOpenFile(rel);
    else void setOpen(rel, true);
  }

  async function renameEntry(rel: string): Promise<void> {
    if (!root) return;
    const rowIdx = rows.findIndex((r) => r.rel === rel);
    if (rowIdx < 0) return;
    const r = rows[rowIdx];
    const el = host.querySelector<HTMLElement>(`[data-rel="${CSS.escape(rel)}"]`);
    if (!el) return;
    el.hidden = true;
    const name = await inlineInput(el, r.depth, r.isDir ? "dir" : "file", r.name);
    el.hidden = false;
    if (!name || name === r.name) return;
    const to = joinRel(parentOf(rel), name);
    try {
      await fsRename(root, rel, to);
    } catch (e) {
      toast(`Could not rename — ${errText(e)}`);
      return;
    }
    afterMove(rel, to);
    await reload([parentOf(rel)]);
  }

  /* ---------------- mutations ---------------- */

  /** Keep tree state (and the editor) pointing at an entry that moved. */
  function afterMove(from: string, to: string): void {
    if (expanded.delete(from)) expanded.add(to);
    for (const key of [...children.keys()]) if (isInside(key, from)) children.delete(key);
    if (selected.delete(from)) selected.add(to);
    if (cursor === from) cursor = to;
    saveExpanded();
    opts.onPathChanged?.(from, to);
  }

  async function deleteTargets(): Promise<void> {
    if (!root) return;
    const rels = targets();
    if (!rels.length) return;
    const what = rels.length === 1 ? `“${rels[0]}”` : `${rels.length} items`;
    const ok = await confirmDialog(
      `Delete ${what}? They go to the Recycle Bin, so this can be undone from Explorer.`,
      "Delete",
    );
    if (!ok) return;
    try {
      await fsTrash(root, rels);
    } catch {
      // No trash available (or the shell refused) — fall back to a hard delete,
      // but say so first: that one really is permanent.
      const hard = await confirmDialog(
        `Recycle Bin unavailable. Delete ${what} permanently?`,
        "Delete permanently",
      );
      if (!hard) return;
      for (const rel of rels) await fsDelete(root, rel).catch(() => {});
    }
    for (const rel of rels) {
      selected.delete(rel);
      for (const key of [...children.keys()]) if (isInside(key, rel)) children.delete(key);
      expanded.delete(rel);
    }
    if (cursor && rels.some((r) => isInside(cursor!, r))) cursor = null;
    opts.onPathsGone?.(rels);
    saveExpanded();
    await reload(parentsOf(rels));
  }

  async function pasteInto(dir: string): Promise<void> {
    if (!root || !clipboard) return;
    const { rels, cut } = clipboard;
    const touched = new Set<string>([dir]);
    for (const rel of rels) {
      if (cut && isInside(dir, rel)) continue; // can't move a folder into itself
      try {
        const to = cut ? await fsMove(root, rel, dir) : await fsCopy(root, rel, dir);
        if (cut) afterMove(rel, to);
      } catch (e) {
        toast(`Could not paste “${rel}” — ${errText(e)}`);
        continue;
      }
      if (cut) touched.add(parentOf(rel));
    }
    if (cut) clipboard = null;
    await reload([...touched]);
    render();
  }

  async function duplicate(): Promise<void> {
    if (!root) return;
    const rels = targets();
    for (const rel of rels) {
      try {
        await fsCopy(root, rel, parentOf(rel));
      } catch (e) {
        toast(`Could not duplicate “${rel}” — ${errText(e)}`);
      }
    }
    await reload(parentsOf(rels));
  }

  const copyText = (t: string) => void navigator.clipboard?.writeText(t).catch(() => {});

  /* ---------------- filter ---------------- */

  let searchToken = 0;
  function clearFilter(): void {
    if (!results && !query) return;
    query = "";
    results = null;
    if (filterInput) filterInput.value = "";
    host.classList.remove("filtering");
  }

  /** Walk the workspace breadth-first for names containing `q`. Bounded so a
   *  huge repo can't lock the UI: honours the hidden-folder filter and stops at
   *  SEARCH_VISIT_CAP entries / SEARCH_HIT_CAP hits. */
  async function runSearch(q: string): Promise<void> {
    if (!root) return;
    const token = ++searchToken;
    const needle = q.toLowerCase();
    const hits: TreeRow[] = [];
    const queue: string[] = [""];
    let visited = 0;
    while (queue.length && hits.length < SEARCH_HIT_CAP && visited < SEARCH_VISIT_CAP) {
      const dir = queue.shift()!;
      let entries = children.get(dir);
      if (!entries) {
        try {
          entries = await fsReadDir(root, dir || ".");
          children.set(dir, entries);
        } catch {
          continue;
        }
      }
      if (token !== searchToken) return; // a newer keystroke took over
      for (const e of sortEntries(filterEntries(entries, showHidden))) {
        visited++;
        const rel = joinRel(dir, e.name);
        if (e.name.toLowerCase().includes(needle)) {
          hits.push({ rel, name: e.name, isDir: e.is_dir, depth: 0 });
          if (hits.length >= SEARCH_HIT_CAP) break;
        }
        if (e.is_dir) queue.push(rel);
      }
    }
    if (token !== searchToken) return;
    results = hits;
    host.classList.add("filtering");
    render();
  }

  let searchTimer: number | undefined;
  filterInput?.addEventListener("input", () => {
    const q = filterInput.value.trim();
    query = q;
    window.clearTimeout(searchTimer);
    if (!q) {
      results = null;
      host.classList.remove("filtering");
      render();
      return;
    }
    searchTimer = window.setTimeout(() => void runSearch(q), 180);
  });
  filterInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      clearFilter();
      render();
      host.focus();
    } else if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      const first = rows[0];
      if (first) {
        select(first.rel, "set");
        host.focus();
        if (e.key === "Enter" && !first.isDir) onOpenFile(first.rel);
      }
    }
  });

  /* ---------------- menus ---------------- */

  function rowMenu(e: MouseEvent, rel: string): void {
    e.preventDefault();
    e.stopPropagation();
    if (!selected.has(rel)) select(rel, "set");
    const r = rowOf(rel);
    const isDir = !!r?.isDir;
    const many = selected.size > 1;
    const dir = isDir ? rel : parentOf(rel);
    const items: MenuItem[] = [];
    if (isDir && !many) {
      items.push(
        { label: "New file", action: () => void newEntry(rel, "file") },
        { label: "New folder", action: () => void newEntry(rel, "dir") },
        { sep: true },
      );
    }
    if (!many) {
      items.push({ label: "Reveal in File Explorer", action: () => void fsReveal(root!, rel) });
      if (opts.onOpenTerminal)
        items.push({ label: "Open in terminal here", action: () => opts.onOpenTerminal!(abs(dir)) });
      if (!isDir)
        items.push({ label: "Open with default app", action: () => void fsOpenExternal(root!, rel) });
      items.push({ sep: true });
    }
    items.push(
      { label: "Cut", hint: "Ctrl+X", action: () => (clipboard = { rels: targets(), cut: true }, render()) },
      { label: "Copy", hint: "Ctrl+C", action: () => (clipboard = { rels: targets(), cut: false }, render()) },
    );
    if (clipboard) items.push({ label: "Paste", hint: "Ctrl+V", action: () => void pasteInto(dir) });
    items.push(
      { label: many ? "Duplicate items" : "Duplicate", action: () => void duplicate() },
      { sep: true },
      { label: "Copy path", action: () => copyText(abs(rel)) },
      { label: "Copy relative path", action: () => copyText(rel) },
      { sep: true },
    );
    if (!many) items.push({ label: "Rename", hint: "F2", action: () => void renameEntry(rel) });
    items.push({
      label: many ? `Delete ${selected.size} items` : "Delete",
      hint: "Del",
      danger: true,
      action: () => void deleteTargets(),
    });
    showMenu(e.clientX, e.clientY, items);
  }

  host.addEventListener("contextmenu", (e) => {
    const rowNode = (e.target as HTMLElement).closest<HTMLElement>(".tw-row");
    if (rowNode?.dataset.rel !== undefined) {
      rowMenu(e, rowNode.dataset.rel);
      return;
    }
    e.preventDefault();
    if (!root) return;
    const items: MenuItem[] = [
      { label: "New file", action: () => void newEntry("", "file") },
      { label: "New folder", action: () => void newEntry("", "dir") },
    ];
    if (clipboard) items.push({ label: "Paste", hint: "Ctrl+V", action: () => void pasteInto("") });
    items.push(
      { sep: true },
      { label: "Reveal in File Explorer", action: () => void fsReveal(root!, ".") },
      { label: "Refresh", action: () => void refresh() },
    );
    showMenu(e.clientX, e.clientY, items);
  });

  /* ---------------- drag & drop (Pointer Events) ---------------- */
  // Not HTML5 DnD: this app has OS-level file-drop enabled, and on WebView2 that
  // swallows dragstart/dragover inside the webview. Pointer capture lives on the
  // host (never on a row) so an auto-expand re-render can't break the drag.

  interface Drag {
    rels: string[];
    startX: number;
    startY: number;
    active: boolean;
    ghost: HTMLElement | null;
    dropDir: string | null;
    hoverRel: string | null;
    hoverTimer: number | undefined;
    overPane: boolean;
  }
  let drag: Drag | null = null;
  let dragged = false; // suppress the click that follows a real drag

  const markDropDir = (rel: string | null) => {
    host.querySelectorAll(".tw-row.drop").forEach((n) => n.classList.remove("drop"));
    host.classList.toggle("drop-root", rel === "");
    if (rel)
      host.querySelector(`[data-rel="${CSS.escape(rel)}"]`)?.classList.add("drop");
  };

  function endDrag(): void {
    if (!drag) return;
    window.clearTimeout(drag.hoverTimer);
    drag.ghost?.remove();
    drag = null;
    document.body.classList.remove("tree-dragging");
    markDropDir(null);
    clearPaneHighlight();
  }

  host.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || editing || results) return;
    const rowNode = (e.target as HTMLElement).closest<HTMLElement>(".tw-row");
    const rel = rowNode?.dataset.rel;
    if (!rel) return;
    dragged = false;
    drag = {
      rels: selected.has(rel) ? topLevelOnly([...selected]) : [rel],
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      ghost: null,
      dropDir: null,
      hoverRel: null,
      hoverTimer: undefined,
      overPane: false,
    };
  });

  host.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
      drag.active = true;
      dragged = true;
      host.setPointerCapture(e.pointerId);
      document.body.classList.add("tree-dragging");
      const g = document.createElement("div");
      g.className = "tw-ghost";
      const first = rowOf(drag.rels[0]);
      g.innerHTML = entryIcon(first?.name ?? "", !!first?.isDir, false);
      const label = document.createElement("span");
      label.textContent =
        drag.rels.length > 1 ? `${drag.rels.length} items` : (first?.name ?? drag.rels[0]);
      g.appendChild(label);
      document.body.appendChild(g);
      drag.ghost = g;
    }
    if (drag.ghost) {
      drag.ghost.style.left = `${e.clientX + 12}px`;
      drag.ghost.style.top = `${e.clientY + 10}px`;
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    // Over a terminal pane → this is the "type the path into the agent" drag.
    if (el?.closest(".pane")) {
      drag.overPane = highlightPaneAt(e.clientX, e.clientY);
      drag.dropDir = null;
      markDropDir(null);
      return;
    }
    drag.overPane = false;
    clearPaneHighlight();
    const overRow = el?.closest<HTMLElement>(".tw-row");
    const overRel = overRow?.dataset.rel;
    let dir: string | null = null;
    if (overRel !== undefined) {
      const r = rowOf(overRel);
      dir = r?.isDir ? overRel : parentOf(overRel);
    } else if (el?.closest(".file-tree")) {
      dir = ""; // empty space under the rows = the workspace root
    }
    // A folder can't take its own subtree, and dropping where it already lives
    // is a no-op — don't offer either as a target.
    if (dir !== null && drag.rels.some((rel) => isInside(dir!, rel) || parentOf(rel) === dir)) {
      dir = null;
    }
    if (dir !== drag.dropDir) {
      drag.dropDir = dir;
      markDropDir(dir);
    }
    // Hovering a closed folder for a beat opens it, so you can drill in mid-drag.
    if (overRel !== drag.hoverRel) {
      drag.hoverRel = overRel ?? null;
      window.clearTimeout(drag.hoverTimer);
      if (overRel && rowOf(overRel)?.isDir && !expanded.has(overRel)) {
        drag.hoverTimer = window.setTimeout(() => void setOpen(overRel, true), 600);
      }
    }
  });

  host.addEventListener("pointerup", (e) => {
    const d = drag;
    if (!d) return;
    if (!d.active) {
      endDrag();
      return;
    }
    const copy = e.ctrlKey || e.metaKey;
    const { rels, dropDir, overPane } = d;
    endDrag();
    if (overPane) {
      dropPathsAtPoint(e.clientX, e.clientY, rels.map(abs));
      return;
    }
    if (dropDir === null || !root) return;
    void (async () => {
      const touched = new Set<string>([dropDir]);
      for (const rel of rels) {
        try {
          const to = copy ? await fsCopy(root!, rel, dropDir) : await fsMove(root!, rel, dropDir);
          if (!copy) {
            afterMove(rel, to);
            touched.add(parentOf(rel));
          }
        } catch (err) {
          toast(`Could not move “${rel}” — ${errText(err)}`);
        }
      }
      await reload([...touched]);
    })();
  });

  host.addEventListener("lostpointercapture", () => endDrag());

  /* ---------------- pointer + keyboard ---------------- */

  host.addEventListener("click", (e) => {
    if (dragged) {
      dragged = false;
      return;
    }
    const rowNode = (e.target as HTMLElement).closest<HTMLElement>(".tw-row");
    const rel = rowNode?.dataset.rel;
    if (rel === undefined) return;
    host.focus();
    const mode: SelectMode = e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "set";
    select(rel, mode);
    if (mode !== "set") return;
    const r = rowOf(rel);
    if (!r) return;
    if (r.isDir && !results) void toggleDir(rel);
    else if (r.isDir) void reveal(rel);
    else onOpenFile(rel);
  });

  host.addEventListener("keydown", (e) => {
    if (!root || editing) return;
    const idx = cursor ? rows.findIndex((r) => r.rel === cursor) : -1;
    const move = (to: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (!r) return;
      select(r.rel, e.shiftKey ? "range" : "set");
      host
        .querySelector<HTMLElement>(`[data-rel="${CSS.escape(r.rel)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(idx + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(idx === -1 ? 0 : idx - 1);
        return;
      case "ArrowRight": {
        e.preventDefault();
        const r = idx >= 0 ? rows[idx] : null;
        if (r?.isDir && !expanded.has(r.rel)) void setOpen(r.rel, true);
        else move(idx + 1);
        return;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const r = idx >= 0 ? rows[idx] : null;
        if (r?.isDir && expanded.has(r.rel)) void setOpen(r.rel, false);
        else if (r) {
          const p = parentOf(r.rel);
          if (p) select(p, "set");
        }
        return;
      }
      case "Enter": {
        e.preventDefault();
        const r = idx >= 0 ? rows[idx] : null;
        if (!r) return;
        if (r.isDir) void toggleDir(r.rel);
        else onOpenFile(r.rel);
        return;
      }
      case "F2":
        e.preventDefault();
        if (cursor) void renameEntry(cursor);
        return;
      case "Delete":
        e.preventDefault();
        void deleteTargets();
        return;
      case "Escape":
        selected = new Set();
        clearFilter();
        render();
        return;
      case "a":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          selected = new Set(rows.map((r) => r.rel));
          render();
        }
        return;
      case "c":
        if ((e.ctrlKey || e.metaKey) && targets().length) {
          e.preventDefault();
          clipboard = { rels: targets(), cut: false };
          render();
        }
        return;
      case "x":
        if ((e.ctrlKey || e.metaKey) && targets().length) {
          e.preventDefault();
          clipboard = { rels: targets(), cut: true };
          render();
        }
        return;
      case "v":
        if ((e.ctrlKey || e.metaKey) && clipboard) {
          e.preventDefault();
          void pasteInto(contextDir());
        }
        return;
      default:
    }
  });

  /* ---------------- toolbar ---------------- */

  function syncToolbar(): void {
    toolbar?.querySelector("#cpHidden")?.classList.toggle("on", showHidden);
  }
  toolbar?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!btn || !root) return;
    switch (btn.id) {
      case "cpNewFile":
        void newEntry(contextDir(), "file");
        break;
      case "cpNewFolder":
        void newEntry(contextDir(), "dir");
        break;
      case "cpRefresh":
        void refresh();
        break;
      case "cpCollapse":
        collapseAll();
        break;
      case "cpHidden":
        showHidden = !showHidden;
        localStorage.setItem("maestro.tree.hidden", showHidden ? "1" : "0");
        syncToolbar();
        render();
        break;
      default:
    }
  });

  /* ---------------- watcher ---------------- */

  const sameRoot = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  void onFsChanged((c) => {
    if (!root || !sameRoot(c.root, root)) return;
    if (c.bulk) void refresh();
    else void reload(c.dirs);
  });

  /* ---------------- public API ---------------- */

  async function refresh(): Promise<void> {
    if (!root) return;
    const dirs = [...children.keys()];
    await Promise.all(dirs.map((d) => load(d)));
    render();
  }

  function setRoot(dir: string | null): void {
    root = dir;
    closeMenu();
    children.clear();
    expanded.clear();
    selected = new Set();
    anchor = null;
    cursor = null;
    rows = [];
    clipboard = null;
    clearFilter();
    syncToolbar();
    if (!dir) {
      host.replaceChildren();
      host.innerHTML = `<div class="tw-msg">No folder for this workspace</div>`;
      void watchStop().catch(() => {});
      return;
    }
    host.innerHTML = `<div class="tw-msg">Loading…</div>`;
    void (async () => {
      await load("");
      // Restore the folders that were open last time in this workspace.
      for (const rel of loadExpanded()) {
        expanded.add(rel);
        await load(rel);
      }
      if (root !== dir) return; // the workspace switched while we were loading
      render();
      await watchStart(dir).catch(() => {});
    })();
  }

  host.tabIndex = 0;
  host.setAttribute("role", "tree");
  return { setRoot, reveal, refresh };
}

/* ---------------- small helpers ---------------- */

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "Failed" in e) return String((e as { Failed: string }).Failed);
  return e instanceof Error ? e.message : "failed";
}

/** Transient message under the tree — file operations fail for mundane reasons
 *  (name taken, file locked) and silently doing nothing is worse than a line. */
function toast(text: string): void {
  const host = document.getElementById("fileTree");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "tw-toast";
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
