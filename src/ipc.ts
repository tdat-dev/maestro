import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Thin wrappers around the Tauri pty_* commands. All @tauri-apps imports live
 * here so the rest of the UI stays transport-agnostic and easy to test.
 */
export async function spawnPty(
  program: string,
  args: string[],
  cols: number,
  rows: number,
  onBytes: (bytes: Uint8Array) => void,
): Promise<void> {
  // Rust `Vec<u8>` arrives over the Channel as a JS number[]; wrap for xterm.
  const ch = new Channel<number[]>();
  ch.onmessage = (msg) => onBytes(new Uint8Array(msg));
  await invoke("pty_spawn", { program, args, cols, rows, onBytes: ch });
}

export async function sendInput(data: string): Promise<void> {
  await invoke("pty_input", { data });
}

export async function resizePty(cols: number, rows: number): Promise<void> {
  await invoke("pty_resize", { cols, rows });
}

export async function killPty(): Promise<void> {
  await invoke("pty_kill");
}

export async function onExit(cb: (code: number) => void): Promise<UnlistenFn> {
  return listen<number>("pty-exit", (e) => cb(e.payload));
}
