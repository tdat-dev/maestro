/* Tiny localStorage helpers shared by the dock tools (Kanban, Pomodoro, Diff).
 * Keep them dependency-free so each tool stays unit-testable in isolation. */

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / serialization failure — non-fatal for a side tool */
  }
}

/** Active workspace identity the dock tools scope their state to. `key` is the
 *  stable storage key (the folder path when known, else the volatile tab id so
 *  a dir-less "quick terminal" still gets a session-only board). */
export interface DockContext {
  key: string;
  dir: string | null;
}
