// Lightweight CodeMirror 6 editor for the code panel. Opens one file at a time,
// saves with Ctrl+S, and guards against clobbering edits an agent made to the
// same file on disk (mtime conflict → banner with Reload / Overwrite).
import { EditorState, Compartment, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { fsReadFile, fsWriteFile, fsStat } from "./ipc";
import { langForFile, resolveConflict } from "./codepanel";

interface EditorOpts {
  host: HTMLElement;
  getRoot: () => string | null;
}

/** Map a codepanel language key to a CodeMirror language extension. */
function langExtension(lang: string): Extension {
  switch (lang) {
    case "javascript": return javascript({ jsx: true });
    case "typescript": return javascript({ jsx: true, typescript: true });
    case "json": return json();
    case "css": return css();
    case "html": return html();
    case "markdown": return markdown();
    case "rust": return rust();
    case "python": return python();
    case "yaml": return yaml();
    default: return [];
  }
}

const POLL_MS = 3000;
const CONFLICT_BANNER =
  `File changed on disk. <button data-ed="overwrite">Overwrite</button> <button data-ed="reload">Reload</button>`;

export function initEditor(opts: EditorOpts): { open(relPath: string): Promise<void> } {
  const { host, getRoot } = opts;

  // Banner + editor mount.
  const banner = document.createElement("div");
  banner.className = "ed-banner";
  banner.hidden = true;
  const mount = document.createElement("div");
  mount.className = "ed-mount";
  mount.hidden = true;
  const empty = document.createElement("div");
  empty.className = "ed-empty";
  empty.textContent = "Select a file to edit";
  host.replaceChildren(banner, empty, mount);

  const langComp = new Compartment();
  let view: EditorView | null = null;
  let openRel: string | null = null;
  let openRoot: string | null = null;
  let diskMtime = 0;
  let saved = ""; // last-saved/loaded doc text — dirty = current !== saved
  let pollTimer: number | null = null;

  const current = () => view?.state.doc.toString() ?? "";
  const isDirty = () => current() !== saved;

  function setBanner(htmlStr: string | null): void {
    if (!htmlStr) {
      banner.hidden = true;
      banner.replaceChildren();
      return;
    }
    banner.hidden = false;
    banner.innerHTML = htmlStr;
  }

  function renderDirty(): void {
    host.closest(".code-panel")?.classList.toggle("ed-dirty", isDirty());
  }

  async function doSave(force: boolean): Promise<void> {
    if (!openRel || !openRoot) return;
    try {
      const res = await fsWriteFile(openRoot, openRel, current(), force ? null : diskMtime);
      diskMtime = res.mtime;
      saved = current();
      setBanner(null);
      renderDirty();
    } catch (err) {
      // A Conflict error serializes as { Conflict: <mtime> }.
      const conflictMtime = (err as { Conflict?: number })?.Conflict;
      if (typeof conflictMtime === "number") {
        diskMtime = conflictMtime;
        setBanner(CONFLICT_BANNER);
      } else {
        setBanner(`Save failed.`);
      }
    }
  }

  async function reload(): Promise<void> {
    if (!openRel || !openRoot || !view) return;
    const f = await fsReadFile(openRoot, openRel);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.content } });
    diskMtime = f.mtime;
    saved = f.content;
    setBanner(null);
    renderDirty();
  }

  banner.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).dataset.ed;
    if (act === "overwrite") void doSave(true);
    else if (act === "reload") void reload();
  });

  async function poll(): Promise<void> {
    if (!openRel || !openRoot) return;
    try {
      const s = await fsStat(openRoot, openRel);
      if (s.mtime === diskMtime) return;
      const action = resolveConflict(true, isDirty());
      if (action === "reload") await reload();
      else if (action === "banner") {
        diskMtime = s.mtime; // record so we don't re-prompt every tick
        setBanner(CONFLICT_BANNER);
      }
    } catch {
      /* file vanished or unreadable — leave the buffer as-is */
    }
  }

  async function open(relPath: string): Promise<void> {
    const root = getRoot();
    if (!root) return;
    let f: { content: string; mtime: number };
    try {
      f = await fsReadFile(root, relPath);
    } catch {
      empty.hidden = false;
      mount.hidden = true;
      empty.textContent = "Can't open this file (binary or too large)";
      return;
    }
    empty.hidden = true;
    mount.hidden = false;
    openRel = relPath;
    openRoot = root;
    diskMtime = f.mtime;
    saved = f.content;
    setBanner(null);

    // Highest precedence so Ctrl/Cmd+S wins over basicSetup's keymap + the browser.
    const saveKey = Prec.highest(
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void doSave(false);
            return true;
          },
        },
      ]),
    );
    const state = EditorState.create({
      doc: f.content,
      extensions: [
        basicSetup,
        saveKey,
        langComp.of(langExtension(langForFile(relPath))),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) renderDirty();
        }),
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
      ],
    });
    if (view) view.destroy();
    view = new EditorView({ state, parent: mount });
    renderDirty();

    if (pollTimer === null) {
      pollTimer = window.setInterval(() => void poll(), POLL_MS);
      window.addEventListener("focus", () => void poll());
    }
  }

  return { open };
}
