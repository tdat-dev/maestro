/* Pure helpers for git worktree isolation (branch naming). Path computation
 * lives in Rust (worktree.rs) since it creates the directory. */

/** Filesystem/branch-safe slug: lowercase, non-alphanumerics → single dash. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Branch for an agent: `maestro/<name-slug>-<shortId>` (collision-resistant). */
export function branchName(agentName: string, shortId: string): string {
  const base = slug(agentName) || "agent";
  return `maestro/${base}-${shortId}`;
}
