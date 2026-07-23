/* Structured dispatch: turn a kanban card into the prompt typed into an
 * agent's terminal. Pure (no DOM/IPC) so it stays unit-testable. */

import type { Card } from "./board";

/** Plain task text: title, description, open checklist items. */
export function cardToAgentText(card: Card): string {
  const lines = [`Task: ${card.title.trim()}`];
  const desc = card.desc.trim();
  if (desc) lines.push("", desc);
  const todo = card.checklist.filter((i) => !i.done);
  if (todo.length) {
    lines.push("");
    for (const i of todo) lines.push(`- [ ] ${i.text}`);
  }
  return lines.join("\n");
}

/** Full dispatch prompt: the task plus board-reporting instructions. Agents
 *  with the maestro MCP tools keep the board in step; agents without them
 *  just do the task. */
export function dispatchPrompt(card: Card): string {
  const ref = JSON.stringify(card.title.trim());
  return (
    cardToAgentText(card) +
    "\n\n" +
    `When you start, move this card to "Doing" with the maestro MCP tool ` +
    `card_move (card: ${ref}). When finished, call card_done (card: ${ref}) ` +
    `with a one-line summary. If you don't have maestro tools, just do the task.`
  );
}
