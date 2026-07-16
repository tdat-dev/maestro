import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHandle {
  write(data: Uint8Array): void;
  fit(): { cols: number; rows: number };
  reset(): void;
  dispose(): void;
  focus(): void;
  /** Highlight + jump to the next match for `q` (empty string clears). */
  findNext(q: string): void;
  /** Highlight + jump to the previous match for `q`. */
  findPrev(q: string): void;
  /** Drop all search highlights. */
  clearSearch(): void;
  /** Live-change the font size (px) and refit the viewport to the new metrics. */
  setFontSize(n: number): void;
  /** Subscribe to result-count changes (current index is 1-based, 0 = none). */
  onSearchResults(cb: (current: number, total: number) => void): void;
  /** Subscribe to terminal title changes (OSC 0/1/2). */
  onTitleChange(cb: (title: string) => void): void;
  /** Plain-text snapshot of the last `lines` rendered rows (what's on screen,
   *  de-duplicated by the emulator — not the raw byte stream). For the remote
   *  dashboard's read-only view. */
  snapshot(lines?: number): string;
}

/**
 * Decode an OSC 52 payload (`<targets>;<base64 text>`) to the text a program
 * wants placed on the clipboard. Returns null for anything that must NOT
 * write: the query form (`?` asks the terminal to REPLY with clipboard
 * contents — answering would let any program in the pane read the user's
 * clipboard), a missing/empty payload, or malformed base64.
 */
export function decodeOsc52(data: string): string | null {
  const semi = data.indexOf(";");
  if (semi === -1) return null;
  const payload = data.slice(semi + 1);
  if (!payload || payload === "?") return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return text || null;
  } catch {
    return null; // malformed base64
  }
}

// WebGL renderer is DISABLED (budget 0 → every pane uses the DOM renderer).
//
// On WebView2 (Windows) xterm's WebGL canvases interact badly with the
// compositor: any unrelated repaint — e.g. the glow when toggling a crew card
// in the spawn modal — stalls the GPU for 15-20s and freezes the whole app,
// and the contexts also get lost on idle (the "goes black after a while" bug).
// The DOM renderer is plenty fast for terminal output and has none of these
// problems. Kept as a budget (not deleted) so it's easy to re-enable per-pane
// if a future WebView2 fixes the compositor interaction.
const WEBGL_BUDGET = 0;
let liveWebgl = 0;

const SEARCH_OPTS = {
  decorations: {
    matchBackground: "#3f4a18",
    matchBorder: "#5e6b1f",
    matchOverviewRuler: "#5e6b1f",
    activeMatchBackground: "#c6f135",
    activeMatchBorder: "#c6f135",
    activeMatchColorOverviewRuler: "#c6f135",
  },
} as const;

/**
 * Mount an xterm.js terminal into `container`. Transport-agnostic: input and
 * resize are reported via callbacks, so it can be wired to Tauri (or anything).
 */
export function mountTerminal(
  container: HTMLElement,
  onInput: (data: string) => void,
  onResize: (cols: number, rows: number) => void,
  opts: { webgl?: boolean; openLink?: (url: string) => void; fontSize?: number } = {},
): TerminalHandle {
  const term = new Terminal({
    convertEol: false, // ConPTY already emits \r\n
    cursorBlink: true,
    // Monospace only — a proportional font here breaks xterm's cell grid, and
    // wide lineHeight/letterSpacing bloat every cell (fewer cols/rows per pane).
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
    fontSize: opts.fontSize ?? 13,
    lineHeight: 1.2,
    letterSpacing: 0,
    scrollback: 5000, // generous history so search/scroll can reach older output
    theme: {
      // Not 'transparent': the WebGL renderer can't blend it and falls back to
      // dead #000, splitting panes into black boxes. A near-black with the
      // pane's own tint keeps every renderer consistent with the glass frame.
      background: '#0b0d12',
      foreground: '#e2e8f0', // slate-200
      cursor: '#c6f135',     // maestro accent
      cursorAccent: '#0a0c10',
      selectionBackground: 'rgba(198, 241, 53, 0.3)',
      black: '#1e293b',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#eab308',
      blue: '#3b82f6',
      magenta: '#d946ef',
      cyan: '#06b6d4',
      white: '#f8fafc',
      brightBlack: '#475569',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#fde047',
      brightBlue: '#60a5fa',
      brightMagenta: '#e879f9',
      brightCyan: '#22d3ee',
      brightWhite: '#ffffff'
    }
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  // URLs in output become links, opened with Ctrl+Click only (like Windows
  // Terminal) so a plain click can't hijack focus or fire by accident.
  if (opts.openLink) {
    const openLink = opts.openLink;
    term.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (e.ctrlKey) openLink(uri);
      }),
    );
  }
  term.open(container);
  fit.fit();

  // GPU renderer, but only while under the context budget — past it we keep the
  // default DOM renderer so a big fleet doesn't thrash the GPU.
  let usedWebgl = false;
  if (opts.webgl !== false && liveWebgl < WEBGL_BUDGET) {
    usedWebgl = true;
    liveWebgl++;
    void (async () => {
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          // GPU/WebGL context was dropped — idle, display sleep, driver TDR, or
          // the WebView2 GPU process crashed. Disposing the addon makes xterm
          // fall back to the DOM renderer so this pane keeps rendering instead
          // of going black. Hand the GPU budget slot back too: otherwise the
          // counter leaks and the fleet drifts toward holding more live contexts
          // than the GPU allows, which makes further losses more likely.
          console.warn("[maestro] webgl context lost → DOM renderer fallback");
          webgl.dispose();
          if (usedWebgl) {
            usedWebgl = false;
            liveWebgl--;
          }
        });
        term.loadAddon(webgl);
      } catch {
        // Couldn't create the GPU renderer — the DOM renderer (default) is fine,
        // but release the budget slot we optimistically reserved above.
        if (usedWebgl) {
          usedWebgl = false;
          liveWebgl--;
        }
      }
    })();
  }

  term.onData((data) => onInput(data));

  // Clipboard. xterm core swallows Ctrl+V on Windows: it maps it to the raw
  // ^V byte (0x16), sends that to the PTY and preventDefault()s the keydown,
  // so the browser's native `paste` event never fires. Returning false here
  // makes xterm skip the key entirely WITHOUT cancelling it — the WebView2
  // default action then fires `paste` on xterm's textarea, which xterm's own
  // paste listener turns into exactly one paste. (Do NOT also read the
  // clipboard manually — that's the old double-paste bug.)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.ctrlKey && !e.altKey && e.key.toLowerCase() === "v") {
      return false;
    }
    // Let the app's global shortcuts win: return false so xterm skips the key
    // WITHOUT cancelling it, and the document-level keydown handler fires.
    //   Alt+1..9           pane focus
    //   Ctrl+Tab / +Shift  workspace cycling
    //   Ctrl+Shift+T/F/B   new workspace / find / broadcast
    if (e.type === "keydown") {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        return false;
      }
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === "Tab") {
        return false;
      }
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && ["t", "f", "b"].includes(e.key.toLowerCase())) {
        return false;
      }
    }
    return true;
  });

  // Copy is copy-on-select: highlighting text writes it straight to the OS
  // clipboard, so there's no Ctrl+C step. That also leaves Ctrl+C free to send
  // the interrupt (SIGINT) even when a selection is present, like a real shell.
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
  });

  // OSC 52: programs in the pane set the clipboard themselves. Claude Code's
  // TUI enables mouse tracking, so drag-select never reaches xterm's own
  // selection (copy-on-select above can't fire) — instead Claude Code renders
  // the highlight itself and emits `ESC ] 52 ; c ; <base64> BEL` to copy.
  // xterm has no built-in OSC 52 handler, so without this the sequence is
  // silently dropped and copying inside Claude Code does nothing.
  term.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52(data);
    if (text) void navigator.clipboard.writeText(text).catch(() => {});
    return true; // consume even when not writing (e.g. the `?` query form)
  });

  // Right-click = copy the selection too. Copy-on-select can silently lose
  // the clipboard write on Windows (another process holding the clipboard
  // lock makes writeText reject), so a right-click retries the copy —
  // deliberate and dependable, like Windows Terminal. With no selection the
  // default context menu behaviour is left untouched.
  container.addEventListener("contextmenu", (e) => {
    const sel = term.getSelection();
    if (!sel) return;
    e.preventDefault();
    void navigator.clipboard.writeText(sel).catch(() => {});
  });

  const ro = new ResizeObserver(() => {
    fit.fit();
    onResize(term.cols, term.rows);
  });
  ro.observe(container);

  return {
    write: (data) => term.write(data),
    fit: () => {
      fit.fit();
      return { cols: term.cols, rows: term.rows };
    },
    reset: () => term.reset(),
    dispose: () => {
      ro.disconnect();
      term.dispose();
      if (usedWebgl) liveWebgl--;
    },
    focus: () => term.focus(),
    findNext: (q) => {
      if (q) search.findNext(q, SEARCH_OPTS);
      else search.clearDecorations();
    },
    findPrev: (q) => {
      if (q) search.findPrevious(q, SEARCH_OPTS);
    },
    clearSearch: () => search.clearDecorations(),
    setFontSize: (n) => {
      term.options.fontSize = n;
      // New glyph metrics → reflow to fit the container, mirroring the
      // ResizeObserver so the PTY learns the new cols/rows.
      fit.fit();
      onResize(term.cols, term.rows);
    },
    onSearchResults: (cb) =>
      search.onDidChangeResults((r) => {
        // xterm reports resultIndex (0-based, -1 = none) + resultCount.
        if (!r || r.resultCount === 0) cb(0, 0);
        else cb(r.resultIndex + 1, r.resultCount);
      }),
    onTitleChange: (cb) => term.onTitleChange(cb),
    snapshot: (lines = 40) => {
      try {
        const buf = term.buffer.active;
        const end = buf.length; // includes scrollback
        const start = Math.max(0, end - lines);
        const rows: string[] = [];
        for (let i = start; i < end; i += 1) {
          rows.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
        // Drop trailing blank rows so idle prompts don't pad the view.
        while (rows.length && rows[rows.length - 1].trim() === "") rows.pop();
        return rows.join("\n");
      } catch {
        return ""; // terminal disposed (e.g. after a tab detach)
      }
    },
  };
}
