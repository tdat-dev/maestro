/* "What changed" evidence for card_done: working-tree paths from git status.
 * Best-effort — no git, not a repo, or any git failure just yields []. */

import { execFileSync } from "node:child_process";

export function changedFiles(dir: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => {
      const p = line.slice(3).trim();
      // rename lines look like "R  old -> new" — the new path is the evidence
      const arrow = p.indexOf(" -> ");
      return arrow >= 0 ? p.slice(arrow + 4) : p;
    })
    .map((p) => p.replace(/^"|"$/g, "")) // git quotes paths with special chars
    .filter(Boolean);
}
