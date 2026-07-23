// Lightweight CodeMirror 6 editor for the code panel. Opens one file at a time,
// saves with Ctrl+S, and guards against clobbering edits an agent made to the
// same file on disk (mtime conflict → banner with Reload / Overwrite).
import { EditorState, Compartment, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { fsReadFile, fsWriteFile, fsStat, fsReadDataUrl } from "./ipc";
import { langForFile, resolveConflict, isImageFile } from "./codepanel";

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

/** Dark editor chrome tuned to Maestro's tokens (cursor + matches use lime). */
const maestroTheme = EditorView.theme(
  {
    "&": { color: "var(--text-2)", backgroundColor: "var(--bg)", height: "100%" },
    ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "13px", lineHeight: "1.75", overflow: "auto" },
    ".cm-content": { padding: "8px 0", caretColor: "var(--accent)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(94,194,240,.20)",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,.025)" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted-2)", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 14px", minWidth: "30px" },
    ".cm-foldGutter .cm-gutterElement": { color: "var(--muted-2)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(198,241,53,.13)" },
    "&.cm-focused .cm-matchingBracket": { backgroundColor: "rgba(198,241,53,.18)", outline: "none", color: "var(--accent)" },
    ".cm-tooltip": { background: "var(--surface-2)", border: "1px solid var(--line-strong)", borderRadius: "8px", overflow: "hidden" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "var(--accent-glow)", color: "var(--text)" },
  },
  { dark: true },
);

/** Syntax palette: blue keywords/types, green strings, amber numbers, lime defs. */
const maestroHighlight = HighlightStyle.define([
  { tag: t.comment, color: "var(--muted-2)", fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "#5ec2f0" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#3ad29f" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#ffb84c" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#c6f135" },
  { tag: [t.definition(t.variableName), t.definitionKeyword], color: "#c6f135" },
  { tag: [t.typeName, t.className, t.namespace], color: "#5ec2f0" },
  { tag: [t.propertyName, t.attributeName], color: "#9fb4c6" },
  { tag: t.variableName, color: "var(--text-2)" },
  { tag: t.tagName, color: "#5ec2f0" },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: "var(--muted)" },
  { tag: t.heading, color: "var(--text)", fontWeight: "700" },
  { tag: [t.link, t.url], color: "#5ec2f0", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--err)" },
]);

/** Last path segment for the breadcrumb tab. */
function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i < 0 ? p : p.slice(i + 1);
}

export interface EditorApi {
  open(relPath: string): Promise<void>;
  /** An open file (or a folder above it) was renamed or moved in the tree. */
  pathChanged(from: string, to: string): void;
  /** Paths that no longer exist — close the tab if it points at one of them. */
  pathsGone(rels: string[]): void;
}

export function initEditor(opts: EditorOpts): EditorApi {
  const { host, getRoot } = opts;

  const EXPAND_SVG =
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/></svg>`;
  const COLLAPSE_SVG =
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3a1 1 0 0 0 1-1V4m12 4h-3a1 1 0 0 1-1-1V4M4 16h3a1 1 0 0 1 1 1v3m12-4h-3a1 1 0 0 0-1 1v3"/></svg>`;

  // Breadcrumb tab: filename + dirty dot on the left, actions on the right.
  const tab = document.createElement("div");
  tab.className = "ed-tab";
  tab.hidden = true;
  tab.innerHTML =
    `<span class="ed-dot"></span><span class="ed-tab-name"></span>` +
    `<span class="ed-actions">` +
    `<button class="ed-seg" data-ed-act="preview" hidden></button>` +
    `<button class="ed-act" data-ed-act="max" title="Expand editor (Esc to exit)"></button>` +
    `</span>`;
  const tabName = tab.querySelector(".ed-tab-name") as HTMLElement;
  const previewBtn = tab.querySelector('[data-ed-act="preview"]') as HTMLButtonElement;
  const maxBtn = tab.querySelector('[data-ed-act="max"]') as HTMLButtonElement;
  maxBtn.innerHTML = EXPAND_SVG;
  const banner = document.createElement("div");
  banner.className = "ed-banner";
  banner.hidden = true;
  const mount = document.createElement("div");
  mount.className = "ed-mount";
  mount.hidden = true;
  // Rendered Markdown preview (sanitized) — toggled from the tab for .md files.
  const mdEl = document.createElement("div");
  mdEl.className = "ed-md markdown-body";
  mdEl.hidden = true;
  // Image preview (png/jpg/gif/webp/svg…) — a scrollable checkerboard stage.
  const imgWrap = document.createElement("div");
  imgWrap.className = "ed-img";
  imgWrap.hidden = true;
  const imgEl = document.createElement("img");
  imgEl.className = "ed-img-el";
  imgEl.alt = "";
  imgWrap.appendChild(imgEl);
  const empty = document.createElement("div");
  empty.className = "ed-empty";
  empty.innerHTML =
    `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/></svg>` +
    `<span>Select a file to view or edit</span>`;
  host.replaceChildren(tab, banner, empty, mount, imgWrap, mdEl);

  const langComp = new Compartment();
  let view: EditorView | null = null;
  let openRel: string | null = null;
  let openRoot: string | null = null;
  let diskMtime = 0;
  let saved = ""; // last-saved/loaded doc text — dirty = current !== saved
  let pollTimer: number | null = null;
  let isMarkdown = false;
  let previewing = false;

  /* ---- Markdown preview + expand-to-fullscreen ---- */
  function renderMarkdown(): void {
    const raw = marked.parse(current(), { async: false }) as string;
    mdEl.innerHTML = DOMPurify.sanitize(raw);
  }
  function setPreview(on: boolean): void {
    previewing = on && isMarkdown;
    previewBtn.textContent = previewing ? "Edit" : "Preview";
    if (previewing) renderMarkdown();
    mdEl.hidden = !previewing;
    mount.hidden = previewing;
    if (!previewing) view?.focus();
  }
  previewBtn.addEventListener("click", () => setPreview(!previewing));

  const appEl = () => host.closest<HTMLElement>("#app");
  function setMax(on: boolean): void {
    appEl()?.classList.toggle("editor-max", on);
    maxBtn.innerHTML = on ? COLLAPSE_SVG : EXPAND_SVG;
    maxBtn.title = on ? "Exit full screen (Esc)" : "Expand editor (Esc to exit)";
    if (on && !previewing) view?.focus();
  }
  maxBtn.addEventListener("click", () => setMax(!appEl()?.classList.contains("editor-max")));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && appEl()?.classList.contains("editor-max")) setMax(false);
  });

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
    const dirty = isDirty();
    tab.classList.toggle("dirty", dirty);
    host.closest(".code-panel")?.classList.toggle("ed-dirty", dirty);
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

  /** Tear down the text editor (used when switching to an image preview). */
  function teardownEditor(): void {
    if (view) {
      view.destroy();
      view = null;
    }
    openRel = null;
    openRoot = null;
    saved = "";
    renderDirty();
  }

  async function openImage(root: string, relPath: string): Promise<void> {
    let url: string;
    try {
      url = await fsReadDataUrl(root, relPath);
    } catch {
      teardownEditor();
      mount.hidden = true;
      imgWrap.hidden = true;
      empty.hidden = false;
      (empty.lastElementChild as HTMLElement).textContent = "Can't preview this image (too large)";
      tab.hidden = false;
      tabName.textContent = baseName(relPath);
      return;
    }
    teardownEditor(); // images are read-only — no buffer, save, or poll
    setBanner(null);
    isMarkdown = false;
    previewing = false;
    previewBtn.hidden = true;
    mdEl.hidden = true;
    empty.hidden = true;
    mount.hidden = true;
    imgWrap.hidden = false;
    imgEl.src = url;
    tab.hidden = false;
    tab.classList.remove("dirty");
    tabName.textContent = baseName(relPath);
    tabName.title = relPath.replace(/\\/g, " / ");
  }

  async function open(relPath: string): Promise<void> {
    const root = getRoot();
    if (!root) return;
    if (isImageFile(relPath)) return openImage(root, relPath);
    let f: { content: string; mtime: number };
    try {
      f = await fsReadFile(root, relPath);
    } catch {
      teardownEditor();
      imgWrap.hidden = true;
      mount.hidden = true;
      mdEl.hidden = true;
      previewBtn.hidden = true;
      empty.hidden = false;
      (empty.lastElementChild as HTMLElement).textContent =
        "Can't open this file (binary or too large)";
      tab.hidden = false;
      tabName.textContent = baseName(relPath);
      return;
    }
    empty.hidden = true;
    imgWrap.hidden = true;
    mount.hidden = false;
    tab.hidden = false;
    tabName.textContent = baseName(relPath);
    tabName.title = relPath.replace(/\\/g, " / ");
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
        EditorView.lineWrapping, // wrap long lines — the panel is narrow
        saveKey,
        langComp.of(langExtension(langForFile(relPath))),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) renderDirty();
        }),
        maestroTheme,
        // Highest precedence so this overrides basicSetup's default light palette.
        Prec.highest(syntaxHighlighting(maestroHighlight)),
      ],
    });
    if (view) view.destroy();
    view = new EditorView({ state, parent: mount });
    renderDirty();

    // Markdown files get an Edit ⇄ Preview toggle; others hide it.
    isMarkdown = langForFile(relPath) === "markdown";
    previewBtn.hidden = !isMarkdown;
    setPreview(false);

    if (pollTimer === null) {
      pollTimer = window.setInterval(() => void poll(), POLL_MS);
      window.addEventListener("focus", () => void poll());
    }
  }

  /** True when `rel` is `dir` itself or lives under it. */
  const under = (rel: string, dir: string) => rel === dir || rel.startsWith(`${dir}\\`);

  /** Back to the empty state — the file behind the tab is gone. */
  function closeFile(note: string): void {
    teardownEditor();
    tab.hidden = true;
    mount.hidden = true;
    imgWrap.hidden = true;
    mdEl.hidden = true;
    previewBtn.hidden = true;
    setBanner(null);
    empty.hidden = false;
    (empty.lastElementChild as HTMLElement).textContent = note;
  }

  function pathChanged(from: string, to: string): void {
    if (!openRel || !under(openRel, from)) return;
    openRel = to + openRel.slice(from.length);
    tabName.textContent = baseName(openRel);
    tabName.title = openRel.replace(/\\/g, " / ");
  }

  function pathsGone(rels: string[]): void {
    if (!openRel) return;
    if (!rels.some((r) => under(openRel!, r))) return;
    closeFile(isDirty() ? "The open file was deleted — its unsaved text is gone" : "File deleted");
  }

  return { open, pathChanged, pathsGone };
}
