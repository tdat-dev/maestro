// Maestro's own settings: how agents start, how the inbox gets your attention,
// what Split and Review do, and what happens at startup. One typed store in
// localStorage; every value has a default so a fresh install behaves well.
// Settings → Agents / Inbox / Review render from PREF_META, and each feature
// reads its value through getPref at the moment it acts.

export interface Prefs {
  /** CLI a New agent starts with: a preset id, or "last" for the last one used. */
  defaultCli: string;
  /** How many agents New agent offers to start on one job. */
  defaultCount: 1 | 2 | 3;
  /** Seconds to wait for a new agent's CLI to reach its prompt before typing its job. */
  jobDelay: number;
  /** Give every agent its own git worktree and branch (projects that are git repos). */
  worktree: boolean;
  /** Put the Director's rules into new projects' first agent. */
  directorFirst: boolean;
  /** Windows notification when an agent starts waiting on you. */
  notifyNeeds: boolean;
  /** When an agent needs you and the one on screen is not busy, show it. */
  jumpToNeeds: boolean;
  /** Show the answer box over the terminal (off: a small chip you open when ready). */
  askCard: boolean;
  /** Most terminals Split lays out side by side. */
  splitMax: SplitMax;
  /** Open Changes on its own when the agent on screen finishes with changes. */
  reviewOnDone: boolean;
  /** Reopen last session's projects and agents (stopped) when Maestro starts. */
  restore: boolean;
  /** One-time tips when a feature first becomes useful. */
  tips: boolean;
}

/** How many terminals Split may lay out: 2 side by side up to a 3 × 3 grid. */
export const SPLIT_SIZES = [2, 3, 4, 6, 9] as const;
export type SplitMax = (typeof SPLIT_SIZES)[number];

export const DEFAULTS: Prefs = {
  defaultCli: "last",
  defaultCount: 1,
  jobDelay: 4,
  worktree: true,
  directorFirst: false,
  notifyNeeds: true,
  jumpToNeeds: false,
  askCard: true,
  splitMax: 6,
  reviewOnDone: false,
  restore: true,
  tips: true,
};

const KEY = "maestro.prefs";
const listeners = new Set<(p: Prefs) => void>();

function clamp(p: Partial<Prefs>): Prefs {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as Array<keyof Prefs>) {
    const v = p[k];
    if (v === undefined || typeof v !== typeof DEFAULTS[k]) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  out.defaultCount = ([1, 2, 3] as const).includes(out.defaultCount) ? out.defaultCount : 1;
  out.splitMax = SPLIT_SIZES.includes(out.splitMax) ? out.splitMax : DEFAULTS.splitMax;
  out.jobDelay = Math.min(20, Math.max(1, Math.round(out.jobDelay)));
  return out;
}

/** Split used to stop at 4, the old default, which a saved copy of the prefs
 *  keeps; lift it to the new default once. */
const SPLIT_LIFTED = "maestro.prefs.split6";
function lift(raw: Partial<Prefs>): Partial<Prefs> {
  try {
    if (localStorage.getItem(SPLIT_LIFTED)) return raw;
    localStorage.setItem(SPLIT_LIFTED, "1");
    if ((raw.splitMax as number) === 4) {
      raw = { ...raw, splitMax: DEFAULTS.splitMax };
      localStorage.setItem(KEY, JSON.stringify(raw));
    }
  } catch { /* storage blocked */ }
  return raw;
}

export function getPrefs(): Prefs {
  try {
    return clamp(lift(JSON.parse(localStorage.getItem(KEY) || "{}")));
  } catch {
    return { ...DEFAULTS };
  }
}

export function getPref<K extends keyof Prefs>(k: K): Prefs[K] {
  return getPrefs()[k];
}

export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
  const next = clamp({ ...getPrefs(), [k]: v });
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage full or blocked */ }
  for (const cb of listeners) cb(next);
}

export function resetPrefs(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  for (const cb of listeners) cb(getPrefs());
}

/** Be told when any setting changes. */
export function onPrefs(cb: (p: Prefs) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
