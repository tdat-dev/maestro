// Where each agent CLI keeps its conversation, and how to read it into the
// chat view's items: Claude Code's JSONL transcript, Codex's rollout, opencode's
// session store. The view polls `read` and feeds what comes back to the chat.

import { createChat, type Chat } from "./chatmodel";
import { createCodexChat } from "./codexmodel";
import { createOpencodeChat } from "./opencodemodel";
import { claudeTranscript, codexTranscript, opencodeTranscript } from "./ipc";
import type { Pane } from "./panetypes";

export interface Chunk { path: string; text: string; next: number }

export interface ChatSource {
  createChat(): Chat;
  /** What was written after `offset`. `path` names the conversation; another
   *  one means the agent is in a new conversation. "" until there is one. */
  read(pane: Pane, dir: string, offset: number): Promise<Chunk>;
  /** It needs its own session id (or a start time) to know which conversation is its own. */
  needsSession?: boolean;
}

/** Only a conversation begun after this run started can be its own. */
const since = (pane: Pane) => (pane.spawnedAt ? pane.spawnedAt - 5000 : null);

export const SOURCES: Record<string, ChatSource> = {
  claude: {
    createChat,
    read: (pane, dir, offset) => claudeTranscript(dir, pane.spec.sessionId ?? null, since(pane), offset),
    needsSession: true,
  },
  // Codex and opencode pick their own session ids: the newest one begun in the
  // agent's folder since it started is its own.
  codex: {
    createChat: createCodexChat,
    read: (pane, dir, offset) => codexTranscript(dir, since(pane), null, offset),
  },
  opencode: {
    createChat: createOpencodeChat,
    read: (pane, dir, offset) => opencodeTranscript(dir, since(pane), null, offset),
  },
};

export function sourceOf(pane: Pane): ChatSource | null {
  return SOURCES[pane.spec.badge] ?? null;
}
