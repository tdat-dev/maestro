/** Jobs to try: a short label, and the job it fills in, in the words you would
 *  type. Offered on the start screen and in an empty conversation. */
export const STARTERS: Array<{ label: string; job: string }> = [
  { label: "Explain this codebase", job: "Explain how this codebase is put together, and where to start reading" },
  { label: "Find and fix a bug", job: "Find a bug, fix it, and add a test that would have caught it" },
  { label: "Add missing tests", job: "Add tests for the code that has none" },
  { label: "Review the last commit", job: "Review the last commit and point out anything risky" },
];
