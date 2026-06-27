// Lazy file tree for the active workspace folder. Reads one directory level at a
// time via fs_read_dir; expanding a folder fetches its children on demand. Rows
// are draggable (drop a path into a terminal) and carry a right-click menu for
// file operations (new / rename / delete / copy path) with inline editing.
import {
  fsReadDir,
  fsCreateFile,
  fsCreateDir,
  fsRename,
  fsDelete,
  confirmDialog,
  type FsEntry,
} from "./ipc";
import { filterEntries, sortEntries } from "./codepanel";

interface FileTreeOpts {
  host: HTMLElement;
  onOpenFile: (relPath: string) => void;
}

const CHEVRON =
  '<svg class="tw-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const FOLDER_ICON =
  '<svg class="tw-ic tw-ic-dir" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.8 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const FILE_ICON =
  '<svg class="tw-ic tw-ic-file" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/></svg>';

interface MenuItem {
  label?: string;
  danger?: boolean;
  sep?: boolean;
  action?: () => void;
}

export function initFileTree(opts: FileTreeOpts): { setRoot(dir: string | null): void } {
  const { host, onOpenFile } = opts;
  let root: string | null = null;
  const showHidden = false;

  const joinRel = (rel: string, name: string) => (rel ? `${rel}\\${name}` : name);
  const parentOf = (rel: string) => {
    const i = rel.lastIndexOf("\\");
    return i < 0 ? "" : rel.slice(0, i);
  };

  /* ---- right-click menu (singleton) ---- */
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
      b.textContent = it.label ?? "";
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

  /* ---- refresh a directory subtree after a mutation ---- */
  async function refreshDir(rel: string): Promise<void> {
    if (!rel) {
      const rb = host.querySelector<HTMLElement>(".tw-root");
      if (rb) await renderInto(rb, "");
      return;
    }
    const box = host.querySelector<HTMLElement>(`[data-tw-rel="${CSS.escape(rel)}"]`);
    if (box) {
      box.hidden = false;
      box.previousElementSibling?.classList.add("open");
      await renderInto(box, rel);
    }
  }

  /* ---- inline create (a temporary input row at the top of a folder) ---- */
  async function newEntry(parentRel: string, kind: "file" | "dir"): Promise<void> {
    if (!root) return;
    if (parentRel) await refreshDir(parentRel);
    const box = parentRel
      ? host.querySelector<HTMLElement>(`[data-tw-rel="${CSS.escape(parentRel)}"]`)
      : host.querySelector<HTMLElement>(".tw-root");
    if (!box) return;

    const wrap = document.createElement("div");
    wrap.className = "tw-row tw-input-row";
    wrap.innerHTML = kind === "dir" ? FOLDER_ICON : FILE_ICON;
    const input = document.createElement("input");
    input.className = "tw-input";
    input.placeholder = kind === "file" ? "new-file.ts" : "new-folder";
    input.spellcheck = false;
    wrap.appendChild(input);
    box.prepend(wrap);
    input.focus();

    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      wrap.remove();
      if (!commit || !name || !root) return;
      const rel = joinRel(parentRel, name);
      try {
        if (kind === "file") await fsCreateFile(root, rel);
        else await fsCreateDir(root, rel);
      } catch {
        return; // already exists / invalid name
      }
      await refreshDir(parentRel);
      if (kind === "file") onOpenFile(rel);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => void finish(true));
  }

  /* ---- inline rename in place ---- */
  function renameEntry(rel: string, nameEl: HTMLElement): void {
    const cur = nameEl.textContent ?? "";
    const input = document.createElement("input");
    input.className = "tw-input";
    input.value = cur;
    input.spellcheck = false;
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      nameEl.replaceChildren();
      nameEl.textContent = cur;
      if (commit && v && v !== cur && root) {
        try {
          await fsRename(root, rel, joinRel(parentOf(rel), v));
        } catch {
          return;
        }
        await refreshDir(parentOf(rel));
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => void finish(true));
  }

  async function deleteEntry(rel: string): Promise<void> {
    if (!root) return;
    const ok = await confirmDialog(`Delete "${rel}"? This can't be undone.`, "Delete");
    if (!ok) return;
    try {
      await fsDelete(root, rel);
    } catch {
      return;
    }
    await refreshDir(parentOf(rel));
  }

  const copyPath = (rel: string) => {
    if (root) void navigator.clipboard?.writeText(`${root}\\${rel}`).catch(() => {});
  };

  function rowMenu(e: MouseEvent, rel: string, isDir: boolean, nameEl: HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [];
    if (isDir) {
      items.push(
        { label: "New file", action: () => void newEntry(rel, "file") },
        { label: "New folder", action: () => void newEntry(rel, "dir") },
        { sep: true },
      );
    }
    items.push(
      { label: "Rename", action: () => renameEntry(rel, nameEl) },
      { label: "Delete", danger: true, action: () => void deleteEntry(rel) },
      { sep: true },
      { label: "Copy path", action: () => copyPath(rel) },
    );
    showMenu(e.clientX, e.clientY, items);
  }

  /* ---- render one directory level into `container` ---- */
  async function renderInto(container: HTMLElement, rel: string): Promise<void> {
    if (!root) return;
    let entries: FsEntry[];
    try {
      entries = await fsReadDir(root, rel || ".");
    } catch {
      container.innerHTML = `<div class="tw-msg">Cannot read folder</div>`;
      return;
    }
    const list = sortEntries(filterEntries(entries, showHidden));
    container.replaceChildren();
    for (const ent of list) {
      const row = document.createElement("div");
      row.className = ent.is_dir ? "tw-row tw-dir" : "tw-row tw-file";
      const childRel = joinRel(rel, ent.name);
      row.innerHTML =
        (ent.is_dir ? CHEVRON : `<span class="tw-chev tw-spacer"></span>`) +
        (ent.is_dir ? FOLDER_ICON : FILE_ICON) +
        `<span class="tw-name"></span>`;
      const nameEl = row.querySelector<HTMLElement>(".tw-name")!;
      nameEl.textContent = ent.name;
      container.appendChild(row);

      // Drag onto a terminal pane → its absolute path is typed into the PTY.
      const absPath = `${root}\\${childRel}`;
      row.setAttribute("draggable", "true");
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/plain", absPath);
        e.dataTransfer?.setData("application/x-maestro-path", absPath);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
        document.body.classList.add("tree-dragging");
      });
      row.addEventListener("dragend", () => document.body.classList.remove("tree-dragging"));
      row.addEventListener("contextmenu", (e) => rowMenu(e, childRel, ent.is_dir, nameEl));

      if (ent.is_dir) {
        const kids = document.createElement("div");
        kids.className = "tw-kids";
        kids.dataset.twRel = childRel;
        kids.hidden = true;
        container.appendChild(kids);
        let loaded = false;
        row.addEventListener("click", () => {
          const open = !!kids.hidden;
          kids.hidden = !open;
          row.classList.toggle("open", open);
          if (open && !loaded) {
            loaded = true;
            void renderInto(kids, childRel);
          }
        });
      } else {
        row.addEventListener("click", () => {
          host.querySelectorAll(".tw-row.sel").forEach((n) => n.classList.remove("sel"));
          row.classList.add("sel");
          onOpenFile(childRel);
        });
      }
    }
  }

  function setRoot(dir: string | null): void {
    root = dir;
    closeMenu();
    host.replaceChildren();
    if (!dir) {
      host.innerHTML = `<div class="tw-msg">No folder for this workspace</div>`;
      return;
    }
    const rootBox = document.createElement("div");
    rootBox.className = "tw-root";
    rootBox.dataset.twRel = "";
    host.appendChild(rootBox);
    void renderInto(rootBox, "");
  }

  // Right-click on empty tree space → create at the workspace root.
  host.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".tw-row")) return; // a row handled it
    e.preventDefault();
    if (!root) return;
    showMenu(e.clientX, e.clientY, [
      { label: "New file", action: () => void newEntry("", "file") },
      { label: "New folder", action: () => void newEntry("", "dir") },
    ]);
  });

  return { setRoot };
}
