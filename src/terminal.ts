import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
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
  /** Subscribe to result-count changes (current index is 1-based, 0 = none). */
  onSearchResults(cb: (current: number, total: number) => void): void;
}

// Browsers cap live WebGL contexts (~16) and thrash past that, which is what
// makes a big fleet of panes lag. Only the first N panes get the GPU renderer;
// the rest fall back to the default DOM renderer.
const WEBGL_BUDGET = 8;
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
  opts: { webgl?: boolean } = {},
): TerminalHandle {
  const term = new Terminal({
    convertEol: false, // ConPTY already emits \r\n
    cursorBlink: true,
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: 15,
    lineHeight: 1.15,
    scrollback: 5000, // generous history so search/scroll can reach older output
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
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

  // Windows-terminal-style clipboard: Ctrl+V (and Ctrl+Shift+V) pastes from the
  // OS clipboard into the PTY; Ctrl+C copies the selection if there is one,
  // otherwise it falls through as the usual interrupt. xterm doesn't wire these
  // by default, so we intercept them here and read/write via the Web Clipboard
  // API (works in the WebView2 secure context).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.ctrlKey || e.altKey) return true;
    const key = e.key.toLowerCase();
    if (key === "v") {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) onInput(text);
        })
        .catch(() => {});
      return false; // don't let xterm send the raw ^V (0x16)
    }
    if (key === "c" && !e.shiftKey && term.hasSelection()) {
      const sel = term.getSelection();
      if (sel) {
        void navigator.clipboard.writeText(sel).catch(() => {});
        return false; // copied — swallow so it isn't sent as SIGINT
      }
    }
    return true;
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
    onSearchResults: (cb) =>
      search.onDidChangeResults((r) => {
        // xterm reports resultIndex (0-based, -1 = none) + resultCount.
        if (!r || r.resultCount === 0) cb(0, 0);
        else cb(r.resultIndex + 1, r.resultCount);
      }),
  };
}
