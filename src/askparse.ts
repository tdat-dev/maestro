// Reads what an agent CLI is asking, from the text on its screen.
//
// Every CLI Maestro runs draws its questions the same basic way: a prompt line,
// then numbered options with one marked as selected, then a hint about which
// keys to press. The old attention heuristic only knew that a pane had gone
// quiet; this tells the three cases apart (wants to run something, asked a
// question, or nothing to answer) and says which keys answer each option, so a
// decision can be made from a button instead of from inside the TUI.
//
// Pure: takes the plain-text screen from TerminalHandle.snapshot(), no DOM.

export type AskKind = "run" | "edit" | "question";

export interface AskOption {
  /** Number shown on screen (1-based). */
  n: number;
  label: string;
  /** Bytes that pick this option in the CLI. */
  key: string;
  /** The "No / tell it what to do differently" option. */
  deny?: boolean;
  /** "Yes, and don't ask again" style options. */
  always?: boolean;
}

export interface Ask {
  kind: AskKind;
  /** The question itself ("Do you want to proceed?", or the agent's question). */
  prompt: string;
  /** Short header when the CLI shows one ("Bash command", Claude's "[ ] Topic"). */
  title?: string;
  /** The command or file the agent wants to touch, when it is on screen. */
  detail?: string;
  /** Options the user can pick, without the CLI's own "type something" / "chat" rows. */
  options: AskOption[];
  /** Option number that lets the user type a free answer, when the CLI offers one. */
  freeTextOption?: number;
}

const ESC = "\x1b";

// Box drawing and selection glyphs that wrap every line of a boxed prompt.
const BOX_EDGE = /^[\s│┃|╭╮╰╯─━]+|[\s│┃|╭╮╰╯]+$/g;
// "❯ 1. Yes", "  2. No, and tell Claude … (esc)", "› 1. Yes, proceed (y)", "● 1. Yes, allow once", "> 1. Keep"
const OPTION = /^[❯›●>▸]?\s*(\d{1,2})\s*[.)]\s*(.+?)\s*$/;
// Hints only a live selector draws. A numbered list in the agent's prose has none of these.
const SELECTOR_HINT = /enter to (select|confirm)|esc to cancel|↑\/↓ to navigate|press enter to confirm/i;
const PROMPT_HINT = /do you want to|would you like to|allow execution|allow (this|the following)|proceed\?/i;

function clean(line: string): string {
  return line.replace(BOX_EDGE, "").replace(/\s+$/, "");
}

/** The key that picks option `n`: an explicit single-key shortcut shown in
 *  parentheses wins ("(y)", "(esc)"), otherwise the option number. */
function keyFor(n: number, label: string): string {
  const m = label.match(/\((esc|[a-z])\)\s*$/i);
  if (m) return m[1].toLowerCase() === "esc" ? ESC : m[1].toLowerCase();
  return String(n);
}

function stripShortcut(label: string): string {
  return label.replace(/\s*\((esc|[a-z]|shift\+tab)\)\s*$/i, "").trim();
}

/** Find the last block of consecutive-ish numbered options on screen, with the
 *  line index where it starts. Description lines between options are allowed. */
function lastOptionBlock(lines: string[]): { start: number; end: number; opts: { n: number; label: string }[] } | null {
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return null;
  const found: { n: number; label: string; i: number }[] = [];
  let expect: number | null = null;
  for (let i = end; i >= 0 && i >= end - 40; i--) {
    const m = lines[i].match(OPTION);
    if (!m) continue;
    const n = Number(m[1]);
    if (expect !== null && n !== expect) break;
    found.unshift({ n, label: m[2], i });
    expect = n - 1;
    if (n === 1) break;
  }
  if (!found.length || found[0].n !== 1 || found.length < 2) return null;
  return { start: found[0].i, end, opts: found.map(({ n, label }) => ({ n, label })) };
}

/**
 * What the agent is asking right now, or null when there is nothing to answer.
 * `screen` is the visible text, newest line last.
 */
export function parseAsk(screen: string): Ask | null {
  const lines = screen.split(/\r?\n/).map(clean);
  const block = lastOptionBlock(lines);
  if (!block) return null;

  // Everything after the options must be selector chrome, not new conversation:
  // if the agent kept talking below the list, the list is prose, not a prompt.
  const after = lines.slice(block.end + 1).filter((l) => l.trim());
  const before = lines.slice(Math.max(0, block.start - 14), block.start);
  const labels = block.opts.map((o) => o.label).join("\n");
  const hinted =
    after.some((l) => SELECTOR_HINT.test(l)) ||
    /\(esc\)\s*$/im.test(labels) ||
    before.some((l) => PROMPT_HINT.test(l));
  if (!hinted) return null;
  const tailIsChrome = after.every(
    (l) => SELECTOR_HINT.test(l) || /^[─━\s]+$/.test(l) || OPTION.test(l) || /^\s{2,}\S/.test(l) || /^[>›❯]\s*$/.test(l),
  );
  if (!tailIsChrome) return null;

  // The prompt is the permission question when there is one ("Would you like to
  // run the following command?" sits above the command in Codex), otherwise the
  // nearest non-empty line above the options.
  let promptIdx = -1;
  for (let i = block.start - 1; i >= Math.max(0, block.start - 14); i--) {
    if (PROMPT_HINT.test(lines[i])) { promptIdx = i; break; }
  }
  if (promptIdx < 0)
    for (let i = block.start - 1; i >= Math.max(0, block.start - 14); i--) {
      if (lines[i].trim() && !/^[─━\s]+$/.test(lines[i])) { promptIdx = i; break; }
    }
  const prompt = promptIdx >= 0 ? lines[promptIdx].trim().replace(/^[?]\s*/, "") : "";

  // Claude draws a header chip above its questions: "──── [ ] Topic".
  let title: string | undefined;
  for (let i = promptIdx - 1; i >= Math.max(0, promptIdx - 3); i--) {
    const chip = lines[i]?.match(/\[\s?[ x✔]?\s?\]\s*(.+?)\s*$/);
    if (chip) { title = chip[1]; break; }
  }

  // Classify. A permission prompt asks yes/no about an action; anything else is a question.
  const context = before.join("\n");
  const isEdit = /do you want to (make this edit|create|write|delete|overwrite)/i.test(prompt + "\n" + context);
  const isRun =
    !isEdit &&
    (/do you want to proceed|would you like to run|allow execution|run the following/i.test(prompt + "\n" + context) ||
      /^(bash|shell|powershell) command$/im.test(context));
  const kind: AskKind = isEdit ? "edit" : isRun ? "run" : "question";

  // What it wants to touch: Codex "$ cmd", Gemini "? Shell cmd [...]", Claude's indented line under "Bash command".
  let detail: string | undefined;
  if (kind !== "question") {
    const ctx = lines.slice(Math.max(0, block.start - 14), block.start);
    const dollar = ctx.find((l) => /^\s*\$\s+\S/.test(l));
    const shell = ctx.map((l) => l.match(/^\s*\?\s+Shell\s+(.+?)(\s+\[.*\])?(\s+\(.*\))?\s*$/)).find(Boolean);
    const editOf = (prompt + "\n" + context).match(/(?:edit to|create|write to|delete|overwrite)\s+([^\s?]+)\??/i);
    if (dollar) detail = dollar.replace(/^\s*\$\s+/, "").trim();
    else if (shell) detail = shell[1].trim();
    else if (kind === "edit" && editOf) detail = editOf[1];
    else {
      const head = ctx.findIndex((l) => /^\s*(bash|shell|powershell) command\s*$/i.test(l));
      const first = head >= 0 ? ctx.slice(head + 1).find((l) => l.trim()) : undefined;
      if (first) detail = first.trim();
    }
  }

  let freeTextOption: number | undefined;
  const options: AskOption[] = [];
  for (const o of block.opts) {
    const label = stripShortcut(o.label);
    if (/^type something\.?$/i.test(label)) { freeTextOption = o.n; continue; }
    if (/^chat about this\.?$/i.test(label)) continue;
    options.push({
      n: o.n,
      label,
      key: keyFor(o.n, o.label),
      deny: /^no\b/i.test(label) || undefined,
      always: /^yes,? .*(don't|do not) ask again|^yes,? allow (always|all)/i.test(label) || undefined,
    });
  }
  if (!options.length) return null;

  return { kind, prompt, title, detail, options, freeTextOption };
}

/** The bytes to send for a free-text answer: pick the CLI's "type something"
 *  row when it has one, then the text, then Enter. */
export function freeTextKeys(ask: Ask | null, text: string): string[] {
  const body = text.replace(/\r?\n/g, " ").trim();
  if (ask?.freeTextOption) return [String(ask.freeTextOption), body, "\r"];
  return [body, "\r"];
}
