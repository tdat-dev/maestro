// @ in the chat composer: which file or folder of the agent's folder you mean.
// Pure: finds the @word being typed, ranks the folder's files against it, and
// puts the pick in its place. The composer (chatview.ts) draws the list.

/** The @word the caret is in: where it starts and what is typed after the @. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

export interface MentionHit {
  /** Relative, forward slashes; a folder ends with "/". */
  path: string;
  name: string;
  dir: string;
  folder: boolean;
}

/** Files and the folders they are in, each once. */
export function withFolders(files: string[]): MentionHit[] {
  const out: MentionHit[] = [];
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let k = 1; k < parts.length; k++) dirs.add(parts.slice(0, k).join("/") + "/");
    out.push(hit(f, false));
  }
  for (const d of dirs) out.push(hit(d, true));
  return out;
}

function hit(path: string, folder: boolean): MentionHit {
  const bare = folder ? path.slice(0, -1) : path;
  const cut = bare.lastIndexOf("/");
  return { path, name: bare.slice(cut + 1) + (folder ? "/" : ""), dir: cut < 0 ? "" : bare.slice(0, cut), folder };
}

/** Letters of `q` in order somewhere in `s`: how tightly, or -1. */
function subsequence(s: string, q: string): number {
  let i = 0, gaps = 0, last = -1;
  for (const ch of q) {
    const at = s.indexOf(ch, i);
    if (at < 0) return -1;
    if (last >= 0) gaps += at - last - 1;
    last = at;
    i = at + 1;
  }
  return gaps;
}

/** The best matches for what you typed: the name first, then the path; short paths win ties. */
export function mentionMatches(all: MentionHit[], query: string, limit = 12): MentionHit[] {
  const q = query.toLowerCase().replace(/\\/g, "/");
  const scored: Array<[number, MentionHit]> = [];
  for (const h of all) {
    const name = h.name.toLowerCase();
    const path = h.path.toLowerCase();
    let score: number;
    if (!q) score = h.folder ? 50 : 40 + h.path.split("/").length; // nothing typed yet: top-level things first
    else if (name === q || name === q + "/" || name.replace(/\.[^.]+$/, "") === q) score = 0;
    else if (name.startsWith(q)) score = 10;
    else if (name.includes(q)) score = 20;
    else if (path.includes(q)) score = 30;
    else {
      const gaps = subsequence(q.includes("/") ? path : name, q);
      if (gaps < 0) continue;
      score = 40 + Math.min(gaps, 40);
    }
    scored.push([score + h.path.length / 1000, h]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, h]) => h);
}

/** The composer's text with the @word replaced by the pick, and where the caret goes. */
export function applyMention(text: string, start: number, caret: number, path: string): { text: string; caret: number } {
  const token = /\s/.test(path) ? `@"${path}"` : `@${path}`;
  const rest = text.slice(caret);
  const spaced = rest.startsWith(" ");
  const insert = token + (spaced ? "" : " ");
  // The caret lands after the space, ready for the next word.
  return { text: text.slice(0, start) + insert + rest, caret: start + insert.length + (spaced ? 1 : 0) };
}
