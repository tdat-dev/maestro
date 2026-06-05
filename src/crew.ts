/** A launchable CLI: maps a friendly label to a concrete program + args. */
export interface CliPreset {
  id: string;
  label: string;
  program: string;
  args: string[];
  badge: string;
  shell?: boolean;
}

/** Built-in CLIs offered in the crew picker. Binary names assume the CLI is on
 *  PATH; use the Custom row for anything not listed or named differently. */
export const CLI_PRESETS: CliPreset[] = [
  { id: "claude", label: "Claude Code", program: "claude", args: [], badge: "claude" },
  { id: "codex", label: "Codex", program: "codex", args: [], badge: "codex" },
  { id: "gemini", label: "Gemini", program: "gemini", args: [], badge: "gemini" },
  { id: "aider", label: "Aider", program: "aider", args: [], badge: "aider" },
  { id: "cursor", label: "Cursor Agent", program: "cursor-agent", args: [], badge: "cursor" },
  { id: "opencode", label: "opencode", program: "opencode", args: [], badge: "opencode" },
  { id: "qwen", label: "Qwen Code", program: "qwen", args: [], badge: "qwen" },
  { id: "copilot", label: "GitHub Copilot", program: "copilot", args: [], badge: "copilot" },
  { id: "goose", label: "Goose", program: "goose", args: [], badge: "goose" },
  { id: "powershell", label: "PowerShell", program: "powershell.exe", args: ["-NoLogo"], badge: "shell", shell: true },
  { id: "cmd", label: "CMD", program: "cmd.exe", args: [], badge: "cmd", shell: true },
];

/** Crew the user has composed in the modal: per-preset counts + a custom row. */
export interface CrewState {
  counts: Record<string, number>;
  custom: string;
  customCount: number;
}

/** Split a free-text command into program + args (whitespace-separated). */
export function parseCommand(cmd: string): { program: string; args: string[] } {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  return { program: tokens[0] ?? "", args: tokens.slice(1) };
}

/** Expand a crew into a flat, ordered list of presets to spawn. */
export function expandCrew(state: CrewState): CliPreset[] {
  const out: CliPreset[] = [];
  for (const p of CLI_PRESETS) {
    const n = state.counts[p.id] ?? 0;
    for (let i = 0; i < n; i++) out.push(p);
  }
  const custom = state.custom.trim();
  if (custom && state.customCount > 0) {
    const { program, args } = parseCommand(custom);
    if (program) {
      const cp: CliPreset = { id: "custom", label: custom, program, args, badge: "custom" };
      for (let i = 0; i < state.customCount; i++) out.push(cp);
    }
  }
  return out;
}

/** Resolve a preset's program/args into something Windows CreateProcessW can
 *  actually launch. npm/script CLIs (claude, codex, gemini, …) install as
 *  extension-less or `.cmd` shims that CreateProcessW rejects with "not a valid
 *  Win32 application" (os error 193); only real `.exe`/`.com` binaries run
 *  directly. Everything else is launched through `cmd.exe /c`, which resolves
 *  the right shim via PATHEXT. */
export function launchSpec(
  program: string,
  args: string[],
): { program: string; args: string[] } {
  const direct = /\.(exe|com)$/i.test(program.trim());
  if (direct) return { program, args };
  return { program: "cmd.exe", args: ["/c", program, ...args] };
}

/** Run async tasks with at most `limit` in flight; results keep input order. */
export async function runLimited<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
