/* Feeding text into an agent's PTY the way a human would.
 *
 * Everything that hands work to an agent — the fleet composer, a Kanban card,
 * the Director's `fleet_send`, voice dispatch — used to do one write:
 *
 *     sendInput(id, message + "\r")
 *
 * which is a single `write_all` into ConPTY's input pipe. Against a TUI that
 * does its own line editing (Claude Code) that loses two ways:
 *
 *   - the head of a long blob is dropped — a 144-char message arrived in the
 *     composer starting 66 characters in;
 *   - the trailing CR lands inside the same burst, so the composer reads it as
 *     a newline in the text instead of Enter, and the message just sits there.
 *
 * So: send the body in small chunks, let the TUI breathe between them, then
 * send the CR on its own after a settle delay so it reads as a real keypress.
 * Writes to one agent are serialized, or two hand-offs arriving together would
 * interleave their chunks into gibberish.
 *
 * The pure part takes its `send`/`sleep` injected so it tests without Tauri. */

/** Code points per write. Small enough that ConPTY never has to swallow a
 *  blob, large enough that a paragraph is a handful of writes. */
export const TYPE_CHUNK = 120;
/** Breathing room between chunks. */
export const TYPE_GAP_MS = 12;
/** Gap before Enter — the burst has to be over for it to count as a keypress. */
export const SUBMIT_DELAY_MS = 220;

export interface TypeOpts {
  chunk?: number;
  gapMs?: number;
  submitDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Split by code point, never mid-surrogate — a chunk boundary inside an emoji
 *  or a composed character would put two broken halves on the wire. */
export function chunkText(text: string, size = TYPE_CHUNK): string[] {
  if (size <= 0) return text ? [text] : [];
  const cps = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(""));
  return out;
}

/** Type `text` through `send`, then optionally Enter. */
export async function typeInto(
  send: (data: string) => Promise<void>,
  text: string,
  submit: boolean,
  o: TypeOpts = {},
): Promise<void> {
  const gap = o.gapMs ?? TYPE_GAP_MS;
  const sleep = o.sleep ?? wait;
  const parts = chunkText(text, o.chunk ?? TYPE_CHUNK);
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0 && gap > 0) await sleep(gap);
    await send(parts[i]);
  }
  if (!submit) return;
  const settle = o.submitDelayMs ?? SUBMIT_DELAY_MS;
  if (settle > 0) await sleep(settle);
  await send("\r");
}

// One promise chain per agent id, so concurrent hand-offs queue instead of
// interleaving. Entries are dropped as they drain, so this never grows.
const queues = new Map<string, Promise<void>>();

/** Run `fn` after everything already queued for `key`. Never rejects. */
export function serialize(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  queues.set(key, next);
  void next.then(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}
