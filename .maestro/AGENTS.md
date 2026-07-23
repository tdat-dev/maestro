# Maestro — plan-first protocol

For ANY task in this workspace, do NOT implement immediately.

Shape the plan as FEW, BIG tasks — one card per deliverable — and put the
small concrete steps INSIDE each task as its checklist. Do not create one
task per tiny step.

## If you have the maestro MCP tools (board_get, card_add, …) — preferred

1. Call `board_get` to see the current board.
2. Create one card per big task in the "Proposed" list:
   `card_add` with `list`: "Proposed", a short `title`, a one-line `desc`,
   and `checklist`: the small steps.
3. STOP and wait for the user to review and approve (they move cards to To do).
4. While working: `card_move` your card to "Doing" when you start,
   `card_done` with a one-line summary when you finish.

## Fallback — no maestro tools

1. Write `.maestro/plan.json` as a JSON array of BIG tasks, e.g.
   [{"title":"big task","desc":"one-line detail","label":"blue",
     "subtasks":["small step 1","small step 2"]}]
   (label optional: green | yellow | orange | red | purple | blue;
   subtasks become the card's checklist)
2. STOP and wait. The tasks appear on the Maestro board for review.
3. Only implement the tasks I confirm as approved.
4. When you FINISH a task, append it to `.maestro/done.json` (a JSON array):
   [{"title":"<the exact task title>","summary":"one line on what changed"}]
   Keep titles identical to the plan so the board can match and move the card
   to Done automatically. Do not remove earlier entries.

The live board is always mirrored to `.maestro/board.md`. Read it at the START of
any task to see the current To do / Doing / Done lists and decide what to work on
next — it is refreshed automatically whenever the board changes.
