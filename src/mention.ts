// Parsing for the command bar's @mentions: what token is being typed (for the
// autocomplete), which names match, and how a line fans out into per-agent
// messages. Pure — unit-tested in mention.test.ts. Name resolution to actual
// panes stays in the caller (a name can map to several same-named agents).

/** The `@token` immediately left of the caret, or null when the caret is not
 *  inside one. Returns "" right after a bare "@" so the picker opens. */
export function activeMention(text: string, caret: number): string | null {
  const upto = text.slice(0, caret);
  const m = upto.match(/@(\w*)$/);
  return m ? m[1] : null;
}

/** Agent names whose start matches `query` (case-insensitive); "" matches all. */
export function matchNames(query: string, names: string[]): string[] {
  const q = query.toLowerCase();
  return names.filter((n) => n.toLowerCase().startsWith(q));
}

export type MentionSegment = { name: string | null; body: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Split a line into per-agent messages. Each `@name` (a known agent) starts a
 *  segment that runs until the next mention; text before the first mention goes
 *  to the whole fleet (name: null). Empty bodies are dropped. */
export function splitMentions(text: string, names: string[]): MentionSegment[] {
  if (!names.length) {
    const body = text.trim();
    return body ? [{ name: null, body }] : [];
  }
  // Longest names first so "Ana" doesn't shadow "Anabel".
  const alt = [...names].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const re = new RegExp(`@(${alt})(?:[-\\s]?[1-9][0-9]*)?[:,]?\\s*`, "gi");
  const segs: MentionSegment[] = [];
  let last = 0;
  let lastName: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(last, m.index).trim();
    if (before) segs.push({ name: lastName, body: before });
    // canonical-case the matched name
    lastName = names.find((n) => n.toLowerCase() === m![1].toLowerCase()) ?? m[1];
    last = re.lastIndex;
  }
  const tail = text.slice(last).trim();
  if (tail) segs.push({ name: lastName, body: tail });
  return segs;
}
