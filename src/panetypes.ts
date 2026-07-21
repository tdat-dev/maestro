// Shared workspace/pane/spec types, split out so feature modules can depend on
// them without importing back into main.ts (avoids circular imports).
import { type TerminalHandle } from "./terminal";
import { type Tile } from "./canvas";

/** The launch recipe for one agent — kept on the pane so a session can be
 *  serialized and re-booted. */
export interface AgentSpec {
  program: string;
  args: string[];
  cwd: string | null;
  name: string;
  badge: string;
  color: string;
  mono: string;
  role?: "conductor"; // a conductor gets the orchestration system prompt
  worktree?: string; // worktree path once created (isolated agents)
  branch?: string; // the agent's git branch (isolated agents)
}

/** One agent pane: its DOM, its terminal, and live status bookkeeping. */
export interface Pane {
  id: string;
  el: HTMLElement;
  term: TerminalHandle;
  running: boolean;
  spawnedAt: number | null;
  lastOutputAt: number; // ms of the last PTY output — drives the active/idle status
  lastInputAt: number; // ms of the last user keystroke into this pane (attention reset)
  attention: boolean; // agent went silent after output → probably waiting on the user
  attentionClearedAt: number; // ms attention was last cleared (so a quiet prompt can't re-flag)
  attentionNotified: boolean; // OS notification already fired for the current flag
  color: string;
  spec: AgentSpec; // the launch recipe — kept so the session can be serialized + re-booted
  toggleFind?: () => void; // open/close this pane's find bar (set by wirePaneSearch)
  recording?: string; // absolute path of the active recording file, when recording
}

/** A workspace tab: its own canvas of panes. Only the active one is shown. */
export interface Workspace {
  id: string;
  name: string;
  dir: string | null;
  repoRoot: string | null; // git repo root when isolated; else null
  isolated: boolean; // create a worktree per agent
  gridEl: HTMLElement;
  tabEl: HTMLElement;
  panes: Map<string, Pane>;
  bcastSelected: Set<string>;
  layout: Map<string, Tile>; // canvas position + size per pane id
}
