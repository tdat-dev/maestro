// Pure parser for an agent-produced plan file (.maestro/plan.json). Accepts a
// JSON array of tasks, a {tasks:[...]} wrapper, or a plain markdown checklist /
// bullet list as a fallback — agents don't always write perfectly-shaped JSON.
// No DOM, no IO, so it can be unit-tested in isolation.

export interface PlanTask {
  title: string;
  desc?: string;
  label?: string;
}

const LABEL_KEYS = new Set(["green", "yellow", "orange", "red", "purple", "blue"]);

function normalizeTask(raw: unknown): PlanTask | null {
  if (typeof raw === "string") {
    const title = raw.trim();
    return title ? { title } : null;
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const title = (typeof o.title === "string" ? o.title : typeof o.task === "string" ? o.task : "").trim();
    if (!title) return null;
    const t: PlanTask = { title };
    if (typeof o.desc === "string" && o.desc.trim()) t.desc = o.desc.trim();
    else if (typeof o.detail === "string" && o.detail.trim()) t.desc = o.detail.trim();
    if (typeof o.label === "string" && LABEL_KEYS.has(o.label)) t.label = o.label;
    return t;
  }
  return null;
}

/** Parse a plan file's text into tasks. Tolerant of JSON or markdown lists. */
export function parsePlan(text: string): PlanTask[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 1) JSON array, or { tasks: [...] }.
  try {
    const j: unknown = JSON.parse(trimmed);
    const arr = Array.isArray(j)
      ? j
      : j && typeof j === "object" && Array.isArray((j as { tasks?: unknown }).tasks)
        ? (j as { tasks: unknown[] }).tasks
        : null;
    if (arr) {
      return arr.map(normalizeTask).filter((t): t is PlanTask => t !== null);
    }
  } catch {
    /* not JSON — fall through to markdown */
  }

  // 2) Markdown checklist / bullet list: "- [ ] task", "- task", "* task", "1. task".
  const out: PlanTask[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/);
    if (m && m[1]) out.push({ title: m[1] });
  }
  return out;
}
