// Tiny indirection so side tools (the Kanban board) can type into the active
// agent's terminal without importing main.ts. main.ts registers the real sender
// (which targets the focused pane of the active workspace) at startup.

/** Types `text` into the active agent's PTY. `submit` appends Enter. Returns
 *  false when there is no agent to send to. */
export type AgentSender = (text: string, submit: boolean) => boolean;

let sender: AgentSender | null = null;

export function setAgentSender(fn: AgentSender): void {
  sender = fn;
}

export function sendToAgent(text: string, submit: boolean): boolean {
  return sender ? sender(text, submit) : false;
}

export function hasAgent(): boolean {
  return sender !== null;
}

/* ---- host hooks the board uses to drive the rest of the UI ---- */

let fileOpener: ((path: string) => void) | null = null;
let diffOpener: (() => void) | null = null;

/** main.ts registers how to reveal a file in the code panel. */
export function setFileOpener(fn: (path: string) => void): void {
  fileOpener = fn;
}
export function openFileInPanel(path: string): void {
  fileOpener?.(path);
}

/** main.ts registers how to open the dock's Changes (diff) viewer. */
export function setDiffOpener(fn: () => void): void {
  diffOpener = fn;
}
export function openDiff(): void {
  diffOpener?.();
}

/* ---- drag a Kanban card straight onto a terminal pane ---- */
// The board drags cards with pointer events (HTML5 DnD is swallowed by
// WebView2's OS drag-drop). To let a card be dropped onto an agent pane, main.ts
// registers how to (a) highlight the pane under a client point while dragging and
// (b) type the card's task into that pane's PTY on drop. Coords are client CSS
// pixels (pointer events), so main.ts resolves them WITHOUT DPR scaling.
export interface PaneTargeting {
  /** Highlight the pane under (x, y) as a task-drop target; true if one is there. */
  hover(x: number, y: number): boolean;
  /** Drop the highlight (pointer left the panes or the drag ended off-target). */
  clear(): void;
  /** Type `text` into the PTY of the pane under (x, y) — no Enter; true on hit. */
  drop(x: number, y: number, text: string): boolean;
}

let paneTargeting: PaneTargeting | null = null;

export function setPaneTargeting(t: PaneTargeting): void {
  paneTargeting = t;
}
export function hoverPaneAt(x: number, y: number): boolean {
  return paneTargeting ? paneTargeting.hover(x, y) : false;
}
export function clearPaneTarget(): void {
  paneTargeting?.clear();
}
export function dropTextIntoPaneAt(x: number, y: number, text: string): boolean {
  return paneTargeting ? paneTargeting.drop(x, y, text) : false;
}
