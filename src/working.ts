// What a working agent is doing right now, in words: the step it is running,
// else what its CLI says on screen (Claude Code's "✻ Pondering… (42s · ↓ 1.2k
// tokens · esc to interrupt)"), else that it is thinking. Pure.

import type { StepItem } from "./chatmodel";

/** Claude Code's status line: its word for what it is doing, and the time and tokens beside it. */
export function activityOnScreen(screen: string): { verb: string; detail: string } | null {
  const line = screen.split(/\r?\n/).reverse().find((l) => /esc to interrupt/i.test(l));
  if (!line) return null;
  const verb = /([A-Z][\w'’-]*(?:…|\.\.\.))/.exec(line)?.[1]?.replace(/\.\.\.$/, "…") ?? "";
  const inner = /\(([^()]*esc to interrupt[^()]*)\)/i.exec(line)?.[1] ?? "";
  const detail = inner
    .split("·")
    .map((p) => p.replace(/esc to interrupt/i, "").replace(/[↑↓⚒]/g, "").trim())
    .filter(Boolean)
    .join(" · ");
  return verb || detail ? { verb, detail } : null;
}

const DOING: Record<string, string> = {
  Ran: "Running",
  Read: "Reading",
  Edited: "Editing",
  Wrote: "Writing",
  Deleted: "Deleting",
  "Looked at": "Looking at",
  "Searched for": "Searching for",
  "Looked for files": "Looking for files",
  Listed: "Listing",
  "Searched the web for": "Searching the web for",
  "Asked a helper agent to": "A helper agent is on",
  "Updated the plan": "Updating the plan",
  "Used the skill": "Using the skill",
  "Loaded tools": "Loading tools",
  "Took a screenshot": "Taking a screenshot",
  Watched: "Watching",
  Used: "Using",
  "Asked you": "Waiting for your answer:",
};

/** A running step as what it is doing: "Ran npm test" → "Running npm test". */
export function stepDoing(s: StepItem): string {
  // A command the agent described ("Run the tests") already says what it does.
  if (s.verb === "Ran" && !s.code && s.target) return s.target;
  const verb = DOING[s.verb] ?? s.verb;
  return s.target ? `${verb} ${s.target}` : verb;
}
