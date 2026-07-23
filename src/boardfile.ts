/* board.json persistence for the kanban board — the same file maestro-mcp
 * (the agent-facing MCP server) reads and writes. The UI re-reads before every
 * mutation and passes the last-seen mtime to fs_write_file so a concurrent
 * agent write surfaces as a Conflict instead of being clobbered. */

import { fsCreateDir, fsCreateFile, fsReadFile, fsStat, fsWriteFile } from "./ipc";
import { normalizeLists, type Board } from "./board";

export const BOARD_JSON_REL = ".maestro\\board.json";
const MAESTRO_DIR = ".maestro";

export class BoardFileCorrupt extends Error {}

export interface BoardFile {
  board: Board;
  mtime: number;
}

export function serializeBoard(board: Board): string {
  return JSON.stringify({ version: 2, lists: board.lists }, null, 2);
}

/** The Rust backend's `scoped()` (src-tauri/src/core/fs.rs) rejects a missing
 *  path with `CommandError::Failed("no such path: {io error}")`, which Tauri
 *  serializes to the JS side as `{ Failed: "no such path: ..." }`. Any other
 *  fs_read_file/fs_stat failure (permission denied, ">2 MB", "binary file",
 *  etc.) must NOT be treated as "missing" — swallowing those would feed a
 *  null into kanban's withBoard fallback, which force-writes the stale
 *  in-memory board over a perfectly good on-disk file. */
function isNotFoundError(e: unknown): boolean {
  let msg: string | undefined;
  if (typeof e === "string") msg = e;
  else if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.Failed === "string") msg = o.Failed;
    else if (typeof o.message === "string") msg = o.message;
  }
  return typeof msg === "string" && /no such path/i.test(msg);
}

/** mtime of board.json, or null when the file doesn't exist yet. Any other
 *  failure (permission, backend refusal) propagates — see isNotFoundError. */
export async function statBoardFile(dir: string): Promise<number | null> {
  try {
    return (await fsStat(dir, BOARD_JSON_REL)).mtime;
  } catch (e) {
    if (isNotFoundError(e)) return null;
    throw e;
  }
}

/** Read + parse board.json. null when missing; BoardFileCorrupt on bad
 *  JSON/shape (the caller must NOT write over a corrupt file). Any other read
 *  failure (permission, too-large, binary refusal) propagates — see
 *  isNotFoundError. */
export async function readBoardFile(dir: string): Promise<BoardFile | null> {
  let content: string;
  let mtime: number;
  try {
    ({ content, mtime } = await fsReadFile(dir, BOARD_JSON_REL));
  } catch (e) {
    if (isNotFoundError(e)) return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new BoardFileCorrupt("board.json is not valid JSON");
  }
  const board = normalizeLists(parsed);
  if (!board) throw new BoardFileCorrupt("board.json has no lists array");
  return { board, mtime };
}

/** Write board.json (creating .maestro/ and the file on first use). Rejects
 *  with the backend's Conflict error when expectedMtime is stale. */
export async function writeBoardFile(
  dir: string,
  board: Board,
  expectedMtime: number | null,
): Promise<number> {
  try {
    await fsCreateDir(dir, MAESTRO_DIR);
  } catch {
    /* already exists */
  }
  try {
    await fsCreateFile(dir, BOARD_JSON_REL);
  } catch {
    /* already exists */
  }
  return (await fsWriteFile(dir, BOARD_JSON_REL, serializeBoard(board), expectedMtime)).mtime;
}
