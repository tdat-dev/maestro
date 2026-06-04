import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHandle {
  write(data: Uint8Array): void;
  fit(): { cols: number; rows: number };
  dispose(): void;
}

/**
 * Mount an xterm.js terminal into `container`. Transport-agnostic: input and
 * resize are reported via callbacks, so it can be wired to Tauri (or anything).
 */
export function mountTerminal(
  container: HTMLElement,
  onInput: (data: string) => void,
  onResize: (cols: number, rows: number) => void,
): TerminalHandle {
  const term = new Terminal({
    convertEol: false, // ConPTY already emits \r\n
    cursorBlink: true,
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: 14,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  // Optional GPU renderer with graceful fallback to the default DOM renderer.
  void (async () => {
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* DOM renderer (default) is fine */
    }
  })();

  term.onData((data) => onInput(data));

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
    dispose: () => {
      ro.disconnect();
      term.dispose();
    },
  };
}
