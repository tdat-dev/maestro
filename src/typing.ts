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
 * That settle delay is a guess about someone else's redraw, and on a real fleet
 * it loses often enough to matter: anything past one chunk arrives as a burst,
 * the CR lands while the TUI is still assembling it, and it is taken as a
 * newline in the text rather than Enter. The message then sits in the composer
 * unsent — until the next short message's CR submits both glued together. So
 * when the caller can show us the pane's screen, we look after pressing Enter
 * and press again while our own text is still sitting there.
 *
 * The pure part takes its `send`/`sleep` injected so it tests without Tauri. */

/** Code points per write. Small enough that ConPTY never has to swallow a
 *  blob, large enough that a paragraph is a handful of writes. */
export const TYPE_CHUNK = 120;
/** Breathing room between chunks. */
export const TYPE_GAP_MS = 12;
/** Gap before Enter — the burst has to be over for it to count as a keypress. */
export const SUBMIT_DELAY_MS = 220;

/** How many extra Enters to try when the first one didn't take, and how long to
 *  wait before each check. Growing, because a busy TUI redraws late. */
export const RETRY_WAITS_MS = [400, 700, 1000];

export interface TypeOpts {
  chunk?: number;
  gapMs?: number;
  submitDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Current plain-text screen of the target pane. Given one, `typeInto` checks
   *  the composer after Enter and presses it again while the text it just typed
   *  is still sitting there. */
  screen?: () => string;
  retryWaitsMs?: number[];
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

const squash = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

/** Hints and status lines the TUI prints inside its input box; not typed text. */
const HINT_LINE =
  /press up to edit queued|bypass permissions|shift\+tab to cycle|esc to interrupt|for shortcuts/i;

/** What is currently sitting in the pane's input box, read from a plain-text
 *  screen snapshot.
 *
 *  Claude Code draws the composer between two horizontal rules, with `>` on the
 *  first line and wrapped continuation lines under it. Everything else on the
 *  screen is transcript. Returns "" when the box is empty.
 *
 *  Caveat the callers must respect: the snapshot has no colour, so a dimmed
 *  history suggestion inside an EMPTY box reads exactly like typed text. Never
 *  act on this text alone — only when it matches text you just typed. */
export function composerText(screen: string): string {
  const lines = screen.split(/\r?\n/);
  const rules: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t.length > 10 && /^[─—-]+$/.test(t)) rules.push(i);
  }
  // Codex draws no box: the prompt is a bare `›` line near the bottom with the
  // status footer under it. Read that line alone — the lines below it are not
  // composer content. Only the bottom of the screen, so a transcript echo of an
  // already-sent message higher up is never mistaken for the box.
  if (rules.length < 2) {
    const tail = lines.slice(-6);
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      if (HINT_LINE.test(tail[i])) continue;
      const m = tail[i].match(/^\s*[>›]\s?(.*)$/);
      if (m) return m[1].replace(/\s+/g, " ").trim();
    }
    return "";
  }
  const region = lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]);
  const body: string[] = [];
  let seen = false;
  for (const l of region) {
    if (HINT_LINE.test(l)) continue;
    const m = l.match(/^\s*[>›]\s?(.*)$/);
    if (m) {
      seen = true;
      body.push(m[1]);
    } else if (seen) body.push(l);
  }
  return body.join(" ").replace(/\s+/g, " ").trim();
}

/** True when what's in the box is part of the message we just typed — the only
 *  case where pressing Enter again is safe. Unrelated text (a suggestion, or
 *  something the user is typing) must never be submitted on our behalf. */
export function stillHolding(typed: string, screen: string): boolean {
  const box = squash(composerText(screen));
  if (box.length < 12) return false; // too little to tell from a suggestion
  return squash(typed).includes(box);
}

/** Type `text` through `send`, then optionally Enter.
 *
 *  With `o.screen`, the Enter is verified: a TUI that is still assembling the
 *  burst reads the CR as a newline instead of a keypress and the message just
 *  sits in the box, so we look and press again. Returns false when the message
 *  was still in the box after the last retry. */
export async function typeInto(
  send: (data: string) => Promise<void>,
  text: string,
  submit: boolean,
  o: TypeOpts = {},
): Promise<boolean> {
  const gap = o.gapMs ?? TYPE_GAP_MS;
  const sleep = o.sleep ?? wait;
  const parts = chunkText(text, o.chunk ?? TYPE_CHUNK);
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0 && gap > 0) await sleep(gap);
    await send(parts[i]);
  }
  if (!submit) return true;
  const settle = o.submitDelayMs ?? SUBMIT_DELAY_MS;
  if (settle > 0) await sleep(settle);
  await send("\r");
  const screen = o.screen;
  if (!screen) return true;
  for (const waitMs of o.retryWaitsMs ?? RETRY_WAITS_MS) {
    await sleep(waitMs);
    if (!stillHolding(text, screen())) return true;
    await send("\r");
  }
  return !stillHolding(text, screen());
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
