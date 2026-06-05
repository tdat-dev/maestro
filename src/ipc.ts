import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * Thin wrappers around the Tauri pty_* commands. Every call is addressed to a
 * specific agent by `agentId`, so many agents run concurrently.
 */
export async function spawnPty(
  agentId: string,
  program: string,
  args: string[],
  cwd: string | null,
  cols: number,
  rows: number,
  onBytes: (bytes: Uint8Array) => void,
): Promise<void> {
  // Rust `Vec<u8>` arrives over the Channel as a JS number[]; wrap for xterm.
  const ch = new Channel<number[]>();
  ch.onmessage = (msg) => onBytes(new Uint8Array(msg));
  await invoke("pty_spawn", { agentId, program, args, cwd, cols, rows, onBytes: ch });
}

export async function sendInput(agentId: string, data: string): Promise<void> {
  await invoke("pty_input", { agentId, data });
}

export async function resizePty(agentId: string, cols: number, rows: number): Promise<void> {
  await invoke("pty_resize", { agentId, cols, rows });
}

export async function killPty(agentId: string): Promise<void> {
  await invoke("pty_kill", { agentId });
}

export async function onExit(cb: (agentId: string, code: number) => void): Promise<UnlistenFn> {
  return listen<{ id: string; code: number }>("pty-exit", (e) => cb(e.payload.id, e.payload.code));
}

/** Native folder picker. Returns the chosen directory, or null if cancelled. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const res = await open({ directory: true, multiple: false, defaultPath });
  return typeof res === "string" ? res : null;
}
