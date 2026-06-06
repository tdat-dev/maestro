/* Pure unified-diff parser: raw `git diff` text → structured files/hunks/lines
 * for read-only rendering. No git, no Tauri — easily unit-tested. */

export type DiffLineKind = "ctx" | "add" | "del";
export interface DiffLine {
  kind: DiffLineKind;
  text: string; // line content without the leading +/-/space
}
export interface DiffHunk {
  header: string; // the @@ ... @@ line
  lines: DiffLine[];
}
export interface DiffFile {
  path: string; // new path (b/...), or old path for deletions
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      file = { path: "", additions: 0, deletions: 0, hunks: [] };
      hunk = null;
      files.push(file);
    } else if (!file) {
      continue;
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "");
      if (p !== "/dev/null") file.path = p;
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4).replace(/^a\//, "");
      if (!file.path && p !== "/dev/null") file.path = p; // deletions: keep old path
    } else if (line.startsWith("@@")) {
      const end = line.indexOf("@@", 2);
      hunk = { header: end >= 0 ? line.slice(0, end + 2) : line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      const c = line[0];
      const kind: DiffLineKind = c === "+" ? "add" : c === "-" ? "del" : "ctx";
      if (kind === "add") file.additions++;
      else if (kind === "del") file.deletions++;
      hunk.lines.push({ kind, text: line.slice(1) });
    }
  }
  return files;
}
