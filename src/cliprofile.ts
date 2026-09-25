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

export interface CliChoice { id: string; label: string; hint?: string }

/** A setting of the CLI the chat can show and change (effort, permission mode). */
export interface CliSetting {
  /** What it is called in the chat. */
  name: string;
  choices: CliChoice[];
  /** Change it by typing `${command} ${choice.id}`. */
  command?: string;
  /** …or by pressing `key` until the screen shows the choice (Shift+Tab modes). */
  cycle?: { key: string; max: number; shown: (screen: string) => string };
  /** …or, when it can't be set from here, the command that opens the CLI's own picker. */
  picker?: string;
  /** The choice in use, from the CLI's own word for it (as the transcript has it). */
  current?: (said: string) => string | null;
}

export interface CliProfile {
  /** How hard it thinks. */
  effort?: CliSetting;
  /** What it may do without asking. */
  permission?: CliSetting;
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
  // --no-session-persistence: asking must not leave a session in your /resume list.
  const run = launchSpec(program, ["-p", "/cost", "--output-format", "stream-json", "--verbose", "--no-session-persistence"]);
  const out = await runCapture(run.program, run.args, dir, 90_000);
  const facts = parseClaudeInit(out);
  if (!facts) throw new Error("Claude Code didn't list its commands");
  return facts;
}

const EFFORTS: CliChoice[] = [
  { id: "low", label: "Low", hint: "Fastest" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max", hint: "Slowest, deepest" },
];

/** Claude Code's permission mode as its footer shows it ("⏵⏵ accept edits on"); nothing means the default. */
export function claudeModeOnScreen(screen: string): string {
  const s = screen.toLowerCase();
  if (s.includes("bypass permissions on")) return "bypassPermissions";
  if (s.includes("accept edits on")) return "acceptEdits";
  if (s.includes("plan mode on")) return "plan";
  if (s.includes("auto mode on")) return "auto";
  return "default";
}

export const PROFILES: Record<string, CliProfile> = {
  claude: {
    effort: { name: "Effort", choices: [...EFFORTS, { id: "auto", label: "Auto", hint: "The model decides" }], command: "/effort" },
    permission: {
      name: "Permissions",
      choices: [
        { id: "default", label: "Ask first", hint: "Asks before edits and commands" },
        { id: "acceptEdits", label: "Accept edits", hint: "Edits files without asking" },
        { id: "plan", label: "Plan", hint: "Reads and plans, changes nothing" },
        { id: "auto", label: "Auto", hint: "Decides what is safe itself" },
        { id: "bypassPermissions", label: "Bypass", hint: "Never asks (if it was started that way)" },
      ],
      // Shift+Tab steps through the modes; the footer says which one is on.
      cycle: { key: "\x1b[Z", max: 6, shown: claudeModeOnScreen },
    },
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
  codex: {
    modelCommand: "/model",
    // Codex sets effort with the model, in its own /model picker.
    effort: { name: "Effort", choices: [{ id: "minimal", label: "Minimal" }, ...EFFORTS.slice(0, 3), { id: "xhigh", label: "Extra high" }], picker: "/model" },
    permission: {
      name: "Approvals",
      choices: [
        { id: "untrusted", label: "Ask first", hint: "Asks before anything not known safe" },
        { id: "on-request", label: "On request", hint: "Asks when it wants to leave the sandbox" },
        { id: "never", label: "Never ask", hint: "Full access" },
      ],
      picker: "/approvals",
      current: (said) => said.split(/\s/)[0] || null,
    },
  },
  opencode: {
    modelCommand: "/models",
    // opencode's agent: build changes things, plan only reads; Tab switches.
    permission: {
      name: "Agent",
      choices: [{ id: "build", label: "Build", hint: "Edits and runs" }, { id: "plan", label: "Plan", hint: "Reads and plans" }],
      picker: "/agents",
    },
  },
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
