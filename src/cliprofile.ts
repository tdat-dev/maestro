// What each agent CLI offers, taken from the CLI itself rather than written
// down here: its slash commands (Claude Code lists them, with your skills and
// plugins, in the first event of a `-p` run of the local /cost command, which
// never calls the model), and how to change its model (its own /model).
// A CLI without a way to list its commands still gets them: in the terminal,
// typing / opens the CLI's own menu.

import { launchSpec } from "./crew";
import { runCapture } from "./ipc";

export interface CliCommand {
  /** Without the slash: "compact", "impeccable", "codex:rescue". */
  name: string;
  kind: "command" | "skill" | "plugin";
}

export interface CliModel {
  label: string;
  /** What goes after the model command: "/model sonnet". */
  value: string;
  hint?: string;
}

export interface CliProfile {
  /** The CLI's own command for its model; alone it opens the CLI's picker. */
  modelCommand?: string;
  /** Models the chat can switch to with `${modelCommand} ${value}`. */
  models?: CliModel[];
  /** Ask the CLI for its commands, run in the agent's folder. */
  discover?: (program: string, dir: string | null) => Promise<CliFacts>;
}

export interface CliFacts {
  commands: CliCommand[];
  /** The model it is set to use, when it says. */
  model: string | null;
}

/** Claude Code's first stream-json event (type system, subtype init). */
export function parseClaudeInit(out: string): CliFacts | null {
  for (const line of out.split("\n")) {
    if (!line.includes('"init"')) continue;
    let v: Record<string, unknown>;
    try { v = JSON.parse(line); } catch { continue; }
    if (v.type !== "system" || v.subtype !== "init") continue;
    const names = (x: unknown): string[] =>
      Array.isArray(x) ? x.map((i) => (typeof i === "string" ? i : typeof (i as { name?: unknown })?.name === "string" ? (i as { name: string }).name : "")).filter(Boolean) : [];
    const skills = new Set(names(v.skills));
    const commands = names(v.slash_commands).map((name): CliCommand => ({
      name,
      kind: skills.has(name) ? "skill" : name.includes(":") ? "plugin" : "command",
    }));
    return { commands, model: typeof v.model === "string" ? v.model : null };
  }
  return null;
}

async function claudeDiscover(program: string, dir: string | null): Promise<CliFacts> {
  // /cost is answered locally: no model call, nothing billed, and the init
  // event before it carries the full list for this folder (project commands,
  // your skills and plugins included).
  const run = launchSpec(program, ["-p", "/cost", "--output-format", "stream-json", "--verbose"]);
  const out = await runCapture(run.program, run.args, dir, 90_000);
  const facts = parseClaudeInit(out);
  if (!facts) throw new Error("Claude Code didn't list its commands");
  return facts;
}

export const PROFILES: Record<string, CliProfile> = {
  claude: {
    modelCommand: "/model",
    // Claude Code's model aliases; each resolves to the newest of its kind.
    models: [
      { label: "Default", value: "default", hint: "What your plan uses" },
      { label: "Opus", value: "opus" },
      { label: "Sonnet", value: "sonnet" },
      { label: "Haiku", value: "haiku" },
      { label: "Opus Plan", value: "opusplan", hint: "Opus plans, Sonnet builds" },
    ],
    discover: claudeDiscover,
  },
  codex: { modelCommand: "/model" },
  opencode: { modelCommand: "/models" },
};

export function profileOf(badge: string): CliProfile {
  return PROFILES[badge] ?? {};
}

const cache = new Map<string, { at: number; facts: Promise<CliFacts> }>();
const FRESH_MS = 10 * 60_000;

/** The CLI's commands for this folder, asked once and kept for a while. */
export function cliFacts(badge: string, program: string, dir: string | null, refresh = false): Promise<CliFacts> | null {
  const p = profileOf(badge);
  if (!p.discover) return null;
  const key = `${badge}|${program}|${dir ?? ""}`;
  const hit = cache.get(key);
  if (hit && !refresh && Date.now() - hit.at < FRESH_MS) return hit.facts;
  const facts = p.discover(program, dir);
  cache.set(key, { at: Date.now(), facts });
  facts.catch(() => cache.delete(key)); // a failed ask is tried again next time
  return facts;
}
