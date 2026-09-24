// One-time tips: a line in the top pill the first time something they explain
// becomes useful (the first agent in the list, the second agent, the first
// agent to finish). Each shows once, never two close together, and Settings →
// Inbox can turn them off or show them again.

import { topNote } from "./hint";
import { getPref } from "./prefs";

const SEEN = "maestro.tips.seen";
const GAP_MS = 20_000; // never two tips close together
let lastAt = 0;

export const TIPS = {
  welcome: "Press <kbd>?</kbd> to see everything Maestro can do · <kbd>Ctrl</kbd> <kbd>K</kbd> jumps anywhere",
  menu: "Right-click an agent, or its <b>⋯</b>, to rename it, add it to Split, stop or remove it",
  split: "Several agents? <kbd>Alt</kbd> <kbd>S</kbd> shows them side by side, each answering on its own card",
  review: "<kbd>Alt</kbd> <kbd>R</kbd> shows what it changed, to merge or send back",
} as const;
export type TipId = keyof typeof TIPS;

function seen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN) || "[]")); } catch { return new Set(); }
}

export function tipSeen(id: TipId): boolean {
  return seen().has(id);
}

/** Show a tip if it's new, tips are on, and none showed in the last 20 s.
 *  Returns whether it showed. `lead` goes before the tip (an agent's name). */
export function showTip(id: TipId, lead = "", now = Date.now()): boolean {
  if (!getPref("tips")) return false;
  const s = seen();
  if (s.has(id) || now - lastAt < GAP_MS) return false;
  s.add(id);
  try { localStorage.setItem(SEEN, JSON.stringify([...s])); } catch { /* storage blocked */ }
  lastAt = now;
  topNote(lead + TIPS[id], 7000);
  return true;
}

/** Settings → Show tips again. */
export function resetTips(): void {
  try { localStorage.removeItem(SEEN); } catch { /* ignore */ }
  lastAt = 0;
}
