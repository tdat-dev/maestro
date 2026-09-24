/** Where an agent's CLI starts: its worktree, else the project folder, else
 *  the home folder (a project without a folder). Never left to the PTY's own
 *  default, so Maestro always knows it; trailing separators dropped so the
 *  path reads the way the CLI will report its own cwd. */
export function runDir(spec: { worktree?: string; cwd: string | null }, home: string): string {
  const dir = spec.worktree || spec.cwd || home;
  return dir.replace(/(?<=[^:\\/])[\\/]+$/, "");
}

/** Whether two folder paths name the same folder (case and trailing separator aside). */
export function sameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

/** Last path segment, tolerant of trailing and mixed slashes. */
export function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/** Workspace label: the dir basename, else the first free "Project N". */
export function nextWorkspaceName(dir: string | null, taken: string[]): string {
  if (dir) return basename(dir);
  let n = 1;
  while (taken.includes(`Project ${n}`)) n++;
  return `Project ${n}`;
}

/** Which workspace id to activate after `closingId` is removed (neighbour to
 *  the right, else the last; null if it was the only one). */
export function pickNextActive(ids: string[], closingId: string): string | null {
  const rest = ids.filter((x) => x !== closingId);
  if (rest.length === 0) return null;
  const i = ids.indexOf(closingId);
  return rest[Math.min(i, rest.length - 1)];
}

/** Confirm before quitting only when at least one terminal is live. */
export function needsCloseConfirm(total: number): boolean {
  return total > 0;
}
