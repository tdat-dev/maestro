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
