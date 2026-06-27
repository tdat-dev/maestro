// Lazy file tree for the active workspace folder. Reads one directory level at a
// time via fs_read_dir; expanding a folder fetches its children on demand. No
// drag in v1 — click a folder to expand, click a file to open it in the editor.
import { fsReadDir, type FsEntry } from "./ipc";
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

export function initFileTree(opts: FileTreeOpts): { setRoot(dir: string | null): void } {
  const { host, onOpenFile } = opts;
  let root: string | null = null;
  const showHidden = false;

  /** Join a parent rel path with a child name (backslash, Windows). */
  const joinRel = (rel: string, name: string) => (rel ? `${rel}\\${name}` : name);

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
      row.querySelector(".tw-name")!.textContent = ent.name;
      container.appendChild(row);

      // Drag a row onto a terminal pane → its absolute path is typed into that
      // agent's PTY (works for files and folders). Uses a custom dataTransfer
      // type so the pane drop handler can tell it apart from a pane reorder.
      const absPath = `${root}\\${childRel}`;
      row.setAttribute("draggable", "true");
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/plain", absPath);
        e.dataTransfer?.setData("application/x-maestro-path", absPath);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
        document.body.classList.add("tree-dragging");
      });
      row.addEventListener("dragend", () => document.body.classList.remove("tree-dragging"));

      if (ent.is_dir) {
        const kids = document.createElement("div");
        kids.className = "tw-kids";
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
    host.replaceChildren();
    if (!dir) {
      host.innerHTML = `<div class="tw-msg">No folder for this workspace</div>`;
      return;
    }
    const rootBox = document.createElement("div");
    rootBox.className = "tw-root";
    host.appendChild(rootBox);
    void renderInto(rootBox, "");
  }

  return { setRoot };
}
