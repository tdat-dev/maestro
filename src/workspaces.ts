/** Last path segment, tolerant of trailing and mixed slashes. */
export function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/** Workspace label: the dir basename, else the first free "Workspace N". */
export function nextWorkspaceName(dir: string | null, taken: string[]): string {
  if (dir) return basename(dir);
  let n = 1;
  while (taken.includes(`Workspace ${n}`)) n++;
  return `Workspace ${n}`;
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
