/* Kanban board — a Trello-style board scoped to each workspace folder. Editable
 * lists (add / rename / delete / drag-reorder), cards you drag within and across
 * lists with a live drop placeholder, and a card detail view with description,
 * colour labels, due date, and a checklist. State lives in localStorage keyed by
 * the active workspace. Rendered inside a dock panel; see dock.ts. */

import { loadJSON, saveJSON, type DockContext } from "./dockstore";
import {
  LABELS,
  labelHex,
  uid,
  mkCard,
  defaultBoard,
  normalizeLists,
  findCardIn,
  applyDomOrder,
  doneCardIds,
  type Board,
  type Card,
  type List,
} from "./board";
import {
  readBoardFile,
  writeBoardFile,
  statBoardFile,
  BoardFileCorrupt,
  type BoardFile,
} from "./boardfile";

export type { Board, Card } from "./board"; // kanban.test.ts + panels import from here
import {
  fsReadFile,
  fsStat,
  fsWriteFile,
  fsCreateFile,
  fsCreateDir,
  reposUnder,
  gitChangedFiles,
  captureWebPage,
  notify,
} from "./ipc";
import {
  sendToAgent,
  openFileInPanel,
  openDiff,
  hoverPaneAt,
  clearPaneTarget,
  dropTextIntoPaneAt,
  listAgents,
  sendToAgentById,
  focusPane,
} from "./agentbridge";
import { dispatchPrompt } from "./dispatch";
import { planConductor, type ConductorMode } from "./conductor";
import {
  planPipeline,
  pipelinePrompt,
  DEFAULT_PIPELINE,
  ENTRY as PIPE_ENTRY,
} from "./pipeline";
import { parsePlan, type PlanTask } from "./planparse";

/* ---- agent ⇄ board plan gate ---- */
const PLAN_REL = ".maestro\\plan.json";
const DONE_REL = ".maestro\\done.json";
const BOARD_REL = ".maestro\\board.md";
const RULES_DIR = ".maestro";
const RULES_REL = ".maestro\\AGENTS.md";
const PROPOSED_TITLE = "Proposed";
const DONE_TITLE = "Done";

// Written into the workspace so every agent session follows plan-first.
const RULES_TEXT = `# Maestro — plan-first protocol

For ANY task in this workspace, do NOT implement immediately.

Shape the plan as FEW, BIG tasks — one card per deliverable — and put the
small concrete steps INSIDE each task as its checklist. Do not create one
task per tiny step.

## If you have the maestro MCP tools (board_get, card_add, …) — preferred

1. Call \`board_get\` to see the current board.
2. Create one card per big task in the "Proposed" list:
   \`card_add\` with \`list\`: "Proposed", a short \`title\`, a one-line \`desc\`,
   and \`checklist\`: the small steps.
3. STOP and wait for the user to review and approve (they move cards to To do).
4. While working: \`card_move\` your card to "Doing" when you start,
   \`card_done\` with a one-line summary when you finish.

## Fallback — no maestro tools

1. Write \`.maestro/plan.json\` as a JSON array of BIG tasks, e.g.
   [{"title":"big task","desc":"one-line detail","label":"blue",
     "subtasks":["small step 1","small step 2"]}]
   (label optional: green | yellow | orange | red | purple | blue;
   subtasks become the card's checklist)
2. STOP and wait. The tasks appear on the Maestro board for review.
3. Only implement the tasks I confirm as approved.
4. When you FINISH a task, append it to \`.maestro/done.json\` (a JSON array):
   [{"title":"<the exact task title>","summary":"one line on what changed"}]
   Keep titles identical to the plan so the board can match and move the card
   to Done automatically. Do not remove earlier entries.

The live board is always mirrored to \`.maestro/board.md\`. Read it at the START of
any task to see the current To do / Doing / Done lists and decide what to work on
next — it is refreshed automatically whenever the board changes.
`;

// Typed into the focused agent; the user appends their actual task, then Enter.
const PLAN_PRIMER =
  "Read .maestro/AGENTS.md and follow its plan-first protocol — few BIG tasks, small steps as each card's checklist; use the maestro MCP board tools if you have them, else write .maestro/plan.json, then stop. Task: ";

const keyFor = (ctxKey: string) => `maestro.kanban.v2.${ctxKey}`;
const legacyKeyFor = (ctxKey: string) => `maestro.kanban.v1.${ctxKey}`;

const enc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function el(tag: string, cls?: string, html?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

/** Bring any stored shape up to the current Board model — including the v1
 *  {todo,doing,done} format so existing boards survive the upgrade. */
function normalize(raw: unknown, ctxKey: string): Board {
  const asLists = normalizeLists(raw);
  if (asLists) return asLists;
  // legacy v1: { todo:[{id,text}], doing:[...], done:[...] }
  const legacy = loadJSON<Record<string, { id: string; text: string }[]>>(
    legacyKeyFor(ctxKey),
    {},
  );
  if (legacy && (legacy.todo || legacy.doing || legacy.done)) {
    const mk = (title: string, arr?: { id: string; text: string }[]): List => ({
      id: uid("l"),
      title,
      cards: (arr ?? []).map((c) => mkCard(c.text)),
    });
    return { lists: [mk("To do", legacy.todo), mk("Doing", legacy.doing), mk("Done", legacy.done)] };
  }
  return defaultBoard();
}

/** The text typed into an agent's PTY when a card is dropped onto its pane:
 *  title, description, then any UNCHECKED checklist items. No trailing newline —
 *  the drop never presses Enter, so the user can edit before sending. */
export { cardToAgentText } from "./dispatch";

/** Serialise the whole board to the Markdown mirror the agent reads
 *  (`.maestro/board.md`): one section per list, cards as GitHub-style
 *  checkboxes with their description and checklist nested underneath. */
export function boardToMarkdown(board: Board): string {
  const out: string[] = ["# Board", ""];
  for (const list of board.lists) {
    out.push(`## ${list.title} (${list.cards.length})`, "");
    if (!list.cards.length) {
      out.push("_(empty)_", "");
      continue;
    }
    for (const c of list.cards) {
      out.push(`- [${c.done ? "x" : " "}] ${c.title.trim()}`);
      const desc = c.desc.trim();
      if (desc) out.push(`  ${desc.replace(/\n/g, "\n  ")}`);
      for (const item of c.checklist) out.push(`  - [${item.done ? "x" : " "}] ${item.text}`);
    }
    out.push("");
  }
  return out.join("\n");
}

function fmtDue(iso: string): { label: string; overdue: boolean; soon: boolean } {
  const d = new Date(iso + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { label, overdue: diff < 0, soon: diff >= 0 && diff <= 1 };
}

export function createKanban() {
  let ctx: DockContext | null = null;
  let board: Board = defaultBoard();
  let root: HTMLElement | null = null;
  let openCardId: string | null = null; // card detail currently shown

  /* ---- agent plan bridge ---- */
  let dir: string | null = null; // active workspace folder, for the plan file
  let planMtime = 0; // last-seen mtime of .maestro/plan.json (auto-watch)
  let doneMtime = 0; // last-seen mtime of .maestro/done.json (auto-watch)
  let boardMtime: number | null = null; // last-seen board.json mtime (null = no file yet)
  let watchTimer: number | null = null;
  let seen = new Set<string>(); // task titles already imported (survives deletes)
  let doneSeen = new Set<string>(); // done.json titles already moved to Done
  let conductorMode: ConductorMode = "off"; // in-app auto-dispatch scheduler
  const conductorKey = (k: string) => `maestro.kanban.conductor.${k}`;
  // Pipeline in-flight memory: card id → the stage it was dispatched into, so a
  // stage change (agent moved the card on) is detected and the assignee cleared.
  const assignedStage = new Map<string, string>();
  // Reassigned by mount() to also persist + repaint the button; the default
  // just updates the mode so setContext can restore before mount runs.
  let setConductorMode: (m: ConductorMode) => void = (m) => {
    conductorMode = m;
  };

  const seenKey = (k: string) => `maestro.kanban.planseen.${k}`;
  const doneSeenKey = (k: string) => `maestro.kanban.doneseen.${k}`;
  const loadSeen = (k: string) => new Set(loadJSON<string[]>(seenKey(k), []));
  const saveSeen = () => {
    if (ctx) saveJSON(seenKey(ctx.key), [...seen]);
  };
  const saveDoneSeen = () => {
    if (ctx) saveJSON(doneSeenKey(ctx.key), [...doneSeen]);
  };

  function findOrCreateListIn(b: Board, title: string): List {
    let list = b.lists.find((l) => l.title.toLowerCase() === title.toLowerCase());
    if (!list) {
      list = { id: uid("l"), title, cards: [] };
      b.lists.unshift(list); // Proposed sits first
    }
    return list;
  }
  const boardHasTitle = (title: string) =>
    board.lists.some((l) => l.cards.some((c) => c.title.toLowerCase() === title.toLowerCase()));

  /** Import agent-proposed tasks into the Proposed list (skipping ones already
   *  imported or already on the board). Returns how many were added. */
  async function importProposed(tasks: PlanTask[]): Promise<number> {
    let added = 0;
    const fresh = tasks.filter((t) => {
      const key = t.title.toLowerCase();
      return !seen.has(key) && !boardHasTitle(t.title);
    });
    if (!fresh.length) return 0;
    await withBoard((b) => {
      // reset per-attempt: withBoard may re-run this mutator on Conflict retry
      added = 0;
      const list = findOrCreateListIn(b, PROPOSED_TITLE);
      for (const t of fresh) {
        const card = mkCard(t.title);
        if (t.desc) card.desc = t.desc;
        card.labels = [t.label ?? "blue"];
        // Big task, small steps: subtasks land as the card's checklist.
        if (t.subtasks)
          card.checklist = t.subtasks.map((text) => ({ id: uid("i"), text, done: false }));
        list.cards.push(card);
        seen.add(t.title.toLowerCase());
        added += 1;
      }
    });
    saveSeen();
    return added;
  }

  /** Read .maestro/plan.json now and import any new tasks. */
  async function importFromFile(): Promise<number> {
    if (!dir) return 0;
    try {
      const f = await fsReadFile(dir, PLAN_REL);
      planMtime = f.mtime;
      return importProposed(parsePlan(f.content));
    } catch {
      return 0; // no plan file yet
    }
  }

  /** Background poll: when the agent (re)writes plan.json, auto-import. */
  async function pollPlan(): Promise<void> {
    if (!dir) return;
    try {
      const s = await fsStat(dir, PLAN_REL);
      if (s.mtime !== planMtime) await importFromFile();
    } catch {
      /* file not written yet */
    }
  }

  /** Drop the plan-first rules file into the workspace, then prime the agent. */
  async function planWithAI(): Promise<void> {
    if (dir) {
      try {
        await fsCreateDir(dir, RULES_DIR);
      } catch {
        /* already exists */
      }
      try {
        await fsCreateFile(dir, RULES_REL);
      } catch {
        /* already exists */
      }
      try {
        await fsWriteFile(dir, RULES_REL, RULES_TEXT, null);
      } catch {
        /* non-fatal */
      }
    }
    // Prime the focused agent; the user appends the task and presses Enter.
    sendToAgent(PLAN_PRIMER, false);
  }

  /* ---- A: code evidence when a task reaches Done ---- */
  const fileBase = (p: string) => {
    const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return i < 0 ? p : p.slice(i + 1);
  };

  async function resolveRepoRoot(): Promise<string | null> {
    if (!dir) return null;
    try {
      const repos = await reposUnder(dir);
      if (repos.length) return repos[0].path;
    } catch {
      /* git missing */
    }
    return dir;
  }

  /** Attach "what changed" (git) to a finished card, then re-render. */
  async function attachDoneEvidence(card: Card, summary?: string): Promise<void> {
    const repoRoot = (await resolveRepoRoot()) ?? dir ?? "";
    let files: string[] = [];
    if (repoRoot) {
      try {
        files = (await gitChangedFiles(repoRoot)).map((f) => f.path);
      } catch {
        /* not a repo */
      }
    }
    await withBoard((b) => {
      const found = findCardIn(b, card.id);
      if (found) found.card.done = { repoRoot, files, summary, at: Date.now() };
    });
  }

  /** After a drag: if a card just landed in Done, capture its code evidence. */
  function maybeFireDone(cardId: string, fromListId: string | null): void {
    const found = findCard(cardId);
    if (!found) return;
    const nowDone = found.list.title.toLowerCase() === DONE_TITLE.toLowerCase();
    const wasDone =
      !!fromListId &&
      board.lists.find((l) => l.id === fromListId)?.title.toLowerCase() === DONE_TITLE.toLowerCase();
    if (nowDone && !wasDone && !found.card.done) void attachDoneEvidence(found.card);
  }

  /* ---- B: agent reports a finished task → auto-move the card to Done ---- */
  function findCardByTitleIn(b: Board, title: string): { list: List; idx: number; card: Card } | null {
    const t = title.trim().toLowerCase();
    for (const list of b.lists) {
      const idx = list.cards.findIndex((c) => c.title.trim().toLowerCase() === t);
      if (idx >= 0) return { list, idx, card: list.cards[idx] };
    }
    return null;
  }

  async function importDone(): Promise<void> {
    if (!dir) return;
    const entries: { title: string; summary?: string }[] = [];
    try {
      const f = await fsReadFile(dir, DONE_REL);
      doneMtime = f.mtime;
      const parsed: unknown = JSON.parse(f.content);
      for (const e of Array.isArray(parsed) ? parsed : []) {
        if (e && typeof e === "object" && typeof (e as { title?: unknown }).title === "string") {
          const o = e as { title: string; summary?: unknown };
          entries.push({
            title: o.title,
            summary: typeof o.summary === "string" ? o.summary : undefined,
          });
        }
      }
    } catch {
      return; // no done file / invalid JSON
    }
    const fresh = entries.filter((entry) => !doneSeen.has(entry.title.trim().toLowerCase()));
    if (!fresh.length) return;
    // Move/create each card in a single board write, then attach code evidence
    // per card (each of those is its own read-modify-write against the fresh
    // board.json this write just produced).
    const moved: { card: Card; summary?: string }[] = [];
    await withBoard((b) => {
      // reset per-attempt: withBoard may re-run this mutator on Conflict retry
      moved.length = 0;
      const doneList = findOrCreateListIn(b, DONE_TITLE);
      for (const entry of fresh) {
        doneSeen.add(entry.title.trim().toLowerCase());
        const found = findCardByTitleIn(b, entry.title);
        const card = found ? found.card : mkCard(entry.title);
        if (found) found.list.cards.splice(found.idx, 1);
        doneList.cards.push(card);
        moved.push({ card, summary: entry.summary });
      }
    });
    saveDoneSeen();
    for (const { card, summary } of moved) void attachDoneEvidence(card, summary);
  }

  async function pollDone(): Promise<void> {
    if (!dir) return;
    try {
      const s = await fsStat(dir, DONE_REL);
      if (s.mtime !== doneMtime) await importDone();
    } catch {
      /* not written yet */
    }
  }

  /** Background poll: when maestro-mcp (an agent) rewrites board.json, reload.
   *  Skipped mid-drag and while an input inside the board is focused, so the
   *  DOM isn't yanked out from under the user; the next tick catches up. */
  async function pollBoardJson(): Promise<void> {
    if (!dir || drag) return;
    const active = document.activeElement;
    if (
      root &&
      active &&
      root.contains(active) &&
      (active.tagName === "TEXTAREA" || active.tagName === "INPUT")
    )
      return;
    const mtime = await statBoardFile(dir);
    if (mtime === null || mtime === boardMtime) return;
    try {
      const bf = await readBoardFile(dir);
      if (!bf) return;
      const before = doneCardIds(board);
      board = bf.board;
      boardMtime = bf.mtime;
      // An external write (maestro-mcp) landed a card in Done → tell the user.
      for (const l of board.lists) {
        if (l.title.trim().toLowerCase() !== DONE_TITLE.toLowerCase()) continue;
        for (const c of l.cards) {
          if (before.has(c.id)) continue;
          const who = c.done?.by ?? c.assignee ?? "agent";
          kbToast(`✅ ${who} finished: ${c.title}`);
          if (!document.hasFocus()) void notify(`${who} finished a task`, c.title).catch(() => {});
        }
      }
      rerender();
      scheduleBoardFile(); // keep the board.md mirror in step
    } catch {
      /* corrupt right now (or mid-write) — retry next tick */
    }
  }

  /** Conductor tick: when enabled, pair free agents with approved To-do cards
   *  (auto also tops up To do from Proposed), dispatch, and move to Doing. */
  async function conductorTick(): Promise<void> {
    if (conductorMode === "off" || !ctx) return;
    const agents = listAgents().map((a) => ({ id: a.id, name: a.name, running: a.running }));
    if (conductorMode === "pipeline") return pipelineTick(agents);
    const plan = planConductor(conductorMode, board, agents);
    if (!plan.approvals.length && !plan.dispatches.length) return;
    // Auto-approve: pull the planned Proposed cards into To do in one write.
    if (plan.approvals.length) {
      await withBoard((b) => {
        const todo = findOrCreateListIn(b, "To do");
        for (const id of plan.approvals) {
          const found = findCardIn(b, id);
          if (found && found.list !== todo) {
            found.list.cards.splice(found.idx, 1);
            todo.cards.push(found.card);
          }
        }
      });
    }
    // Dispatch each pairing: type the prompt into the agent, claim + move to Doing.
    for (const d of plan.dispatches) {
      const found = findCard(d.cardId);
      if (!found) continue;
      if (sendToAgentById(d.agentId, dispatchPrompt(found.card), true))
        assignCard(d.cardId, d.agentName, true);
    }
  }

  const lc = (s: string) => s.trim().toLowerCase();

  /** Pipeline tick: advance cards through Build → Test → Review. Clears stale
   *  assignees (a hand-off completed) then dispatches each free agent the next
   *  work-stage card with a stage-specific prompt. */
  async function pipelineTick(
    agents: { id: string; name: string; running: boolean }[],
  ): Promise<void> {
    const plan = planPipeline(board, agents, DEFAULT_PIPELINE, assignedStage);
    if (plan.unassign.length) {
      for (const id of plan.unassign) assignedStage.delete(id);
      await withBoard((b) => {
        for (const id of plan.unassign) {
          const f = findCardIn(b, id);
          if (f) f.card.assignee = undefined;
        }
      });
    }
    for (const d of plan.dispatches) {
      const found = findCard(d.cardId);
      if (!found) continue;
      // A To-do card enters the first work stage; a work-stage card stays put.
      const destStage = lc(d.fromTitle) === lc(PIPE_ENTRY) ? DEFAULT_PIPELINE[0].title : d.fromTitle;
      const prompt = pipelinePrompt(dispatchPrompt(found.card), DEFAULT_PIPELINE, destStage);
      if (!sendToAgentById(d.agentId, prompt, true)) continue;
      await withBoard((b) => {
        const f = findCardIn(b, d.cardId);
        if (!f) return;
        f.card.assignee = d.agentName;
        if (lc(f.list.title) !== lc(destStage)) {
          const dest = findOrCreateListIn(b, destStage);
          f.list.cards.splice(f.idx, 1);
          dest.cards.push(f.card);
        }
      });
      assignedStage.set(d.cardId, destStage);
    }
  }

  /* ---- C: screenshot a web preview into the repo ---- */
  const urlKey = () => `maestro.kanban.previewUrl.${ctx?.key ?? ""}`;

  function promptUrl(initial: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (!root) return resolve(null);
      const bar = el("div", "kb-urlbar");
      bar.innerHTML =
        `<input class="kb-url" placeholder="http://localhost:5173" spellcheck="false">` +
        `<button class="kb-add-btn">Capture</button>` +
        `<button class="kb-url-x" aria-label="Cancel">✕</button>`;
      const input = bar.querySelector("input") as HTMLInputElement;
      input.value = initial;
      root.prepend(bar);
      input.focus();
      input.select();
      const done = (v: string | null) => {
        bar.remove();
        resolve(v);
      };
      bar.querySelector(".kb-add-btn")!.addEventListener("click", () => done(input.value.trim() || null));
      bar.querySelector(".kb-url-x")!.addEventListener("click", () => done(null));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(input.value.trim() || null);
        else if (e.key === "Escape") done(null);
      });
    });
  }

  async function captureWeb(): Promise<void> {
    if (!dir) return;
    const url = await promptUrl(localStorage.getItem(urlKey()) ?? "");
    if (!url) return;
    localStorage.setItem(urlKey(), url);
    const name = `shot-${Date.now().toString(36)}.png`;
    try {
      const rel = await captureWebPage(url, dir, name);
      openFileInPanel(`${dir}\\${rel}`); // show the screenshot in the code panel
    } catch {
      /* capture failed — webview/url problem; left silent for now */
    }
  }

  // Drag uses POINTER EVENTS, not HTML5 drag-and-drop. Maestro runs in a Tauri
  // WebView2 window with OS drag-drop enabled (the "drop a file on a pane"
  // feature), which swallows HTML5 dragstart/drop inside the webview. Pointer
  // capture is the pattern that works here (same as the home mascot). We move
  // the real DOM node live as the pointer moves, then rebuild the model from
  // the DOM order on pointerup.
  let drag:
    | {
        type: "card" | "list";
        el: HTMLElement;
        startX: number;
        startY: number;
        pid: number;
        started: boolean;
        overPane: boolean; // pointer is over a terminal pane, not the board
      }
    | null = null;

  // Floating pill that follows the cursor while a card is aimed at an agent pane,
  // so it's obvious which task is about to be sent. Lives on <body> to escape the
  // dock panel's overflow clipping.
  let pill: HTMLElement | null = null;
  function showPill(title: string, x: number, y: number) {
    if (!pill) {
      pill = el("div", "kb-pill");
      document.body.appendChild(pill);
    }
    pill.textContent = `→ ${title}`;
    pill.style.left = `${x}px`;
    pill.style.top = `${y}px`;
    pill.classList.add("on");
  }
  function hidePill() {
    pill?.classList.remove("on");
  }

  /** Transient bottom-right toast (an agent finished a card). */
  function kbToast(text: string): void {
    const t = el("div", "kb-toast", enc(text));
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("on"));
    window.setTimeout(() => {
      t.classList.remove("on");
      window.setTimeout(() => t.remove(), 400);
    }, 4000);
  }
  // True from the moment a real drag starts until the next pointerdown — lets
  // the trailing click after a drag be ignored (so it doesn't open a card or
  // start a rename).
  let dragged = false;

  /** Apply a model change. With a workspace dir the file is the source of
   *  truth: re-read board.json, mutate the fresh copy, write it back guarded by
   *  the mtime we read (an agent write in between = Conflict → retry once on
   *  the newer copy). Dir-less contexts keep the old localStorage behaviour. */
  async function withBoard(mutator: (b: Board) => void): Promise<void> {
    if (!ctx) return;
    if (!dir) {
      mutator(board);
      saveJSON(keyFor(ctx.key), board);
      scheduleBoardFile();
      rerender();
      return;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let bf: BoardFile | null = null;
      try {
        bf = await readBoardFile(dir);
      } catch (e) {
        if (!(e instanceof BoardFileCorrupt)) {
          // permission/too-large/binary-refusal etc: not the user's doing —
          // abort with no write rather than clobbering an unreadable file.
          console.warn("maestro: board.json unreadable — change not saved", e);
          return;
        }
        // corrupt file: mutate the in-memory copy; the forced write below
        // replaces the corrupt file — this is the user's explicit action.
      }
      const fresh = bf ? bf.board : board;
      mutator(fresh);
      try {
        boardMtime = await writeBoardFile(dir, fresh, bf ? bf.mtime : null);
        board = fresh;
        scheduleBoardFile();
        rerender();
        return;
      } catch {
        /* Conflict — an agent wrote between our read and write; retry on its copy */
      }
    }
  }

  /** Re-render whichever view is open (board or card detail). */
  function rerender(): void {
    if (openCardId && findCard(openCardId)) renderDetail();
    else {
      openCardId = openCardId && findCard(openCardId) ? openCardId : null;
      render();
    }
  }

  /** Load the context's board: board.json when the workspace has a dir
   *  (migrating the old localStorage board into the file on first run),
   *  localStorage otherwise. Corrupt file → in-memory default; the file is
   *  only replaced when the user makes a mutation (withBoard's forced write). */
  async function loadBoardForContext(): Promise<void> {
    if (!ctx) return;
    if (!dir) {
      board = normalize(loadJSON<unknown>(keyFor(ctx.key), null), ctx.key);
      return;
    }
    try {
      const bf = await readBoardFile(dir);
      if (bf) {
        board = bf.board;
        boardMtime = bf.mtime;
        return;
      }
    } catch (e) {
      if (e instanceof BoardFileCorrupt) {
        console.warn(
          "maestro: .maestro/board.json is corrupt — showing an in-memory board; fix or delete the file",
        );
      } else {
        // permission/too-large/binary-refusal etc: not corrupt, just unreadable —
        // show the default board but don't touch the file (withBoard aborts too).
        console.warn(
          "maestro: .maestro/board.json is unreadable — showing an in-memory board; changes won't be saved",
          e,
        );
      }
      board = defaultBoard();
      return;
    }
    // No file yet: seed it from the localStorage board (one-time migration; the
    // localStorage copy stays behind as a backup but is no longer read).
    board = normalize(loadJSON<unknown>(keyFor(ctx.key), null), ctx.key);
    try {
      boardMtime = await writeBoardFile(dir, board, null);
    } catch {
      /* folder unwritable — board stays in-memory for this session */
    }
  }

  /* ---- live board mirror the agent reads (.maestro/board.md) ---- */
  let boardWriteTimer: number | null = null;
  function scheduleBoardFile() {
    if (!dir) return;
    if (boardWriteTimer !== null) clearTimeout(boardWriteTimer);
    // Debounced: a burst of edits (or a drag reorder) writes the file once.
    boardWriteTimer = window.setTimeout(() => {
      boardWriteTimer = null;
      void writeBoardMirror();
    }, 500);
  }
  // Named distinctly from the imported `writeBoardFile` (board.json, from
  // ./boardfile) — this one is the board.md mirror the agent reads.
  async function writeBoardMirror() {
    if (!dir) return;
    try {
      await fsCreateDir(dir, RULES_DIR);
    } catch {
      /* already exists */
    }
    try {
      await fsCreateFile(dir, BOARD_REL);
    } catch {
      /* already exists */
    }
    try {
      await fsWriteFile(dir, BOARD_REL, boardToMarkdown(board), null);
    } catch {
      /* non-fatal — folder unwritable */
    }
  }

  /** Slot the dragged node into place under the pointer (live reorder). */
  function onPointerMove(e: PointerEvent) {
    if (!drag || !root) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
      drag.started = true;
      dragged = true;
      drag.el.classList.add(drag.type === "card" ? "dragging" : "list-dragging");
    }
    e.preventDefault();
    if (drag.type === "card") {
      // Aiming at a terminal pane (outside the board) → drop-to-agent, not a
      // reorder. Highlight the pane, trail the pill, and hold the card in place.
      if (hoverPaneAt(e.clientX, e.clientY)) {
        drag.overPane = true;
        showPill((findCard(drag.el.dataset.card ?? "")?.card.title ?? "").trim() || "task", e.clientX, e.clientY);
        return;
      }
      if (drag.overPane) {
        drag.overPane = false;
        clearPaneTarget();
        hidePill();
      }
    }
    const under = document.elementFromPoint(e.clientX, e.clientY);
    if (!under) return;
    if (drag.type === "card") {
      const host = under.closest(".kb-list")?.querySelector<HTMLElement>(".kb-cards");
      if (!host) return;
      const ref = cardAfter(host, e.clientY);
      if (ref) host.insertBefore(drag.el, ref);
      else host.appendChild(drag.el);
    } else {
      const boardNode = root.querySelector(".kb-board");
      if (!boardNode) return;
      const cols = [...boardNode.querySelectorAll<HTMLElement>(".kb-list")].filter((c) => c !== drag!.el);
      const refCol = cols.find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientX < r.left + r.width / 2;
      });
      const tile = boardNode.querySelector<HTMLElement>(".kb-addlist");
      boardNode.insertBefore(drag.el, refCol ?? tile ?? null);
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (!drag) return;
    const { el, pid, started, type, overPane } = drag;
    const cardId = type === "card" ? el.dataset.card ?? null : null;
    const fromListId = el.dataset.list ?? null;
    try {
      el.releasePointerCapture(pid);
    } catch {
      /* ignore */
    }
    drag = null;
    if (!started) return;
    el.classList.remove("dragging", "list-dragging");
    // Dropped onto an agent pane: send the card's task there and leave the board
    // untouched (the card snaps back to where it was — no model change).
    if (overPane && cardId) {
      const found = findCard(cardId);
      const hit = found ? dropTextIntoPaneAt(e.clientX, e.clientY, dispatchPrompt(found.card)) : null;
      if (hit) assignCard(cardId, hit.name, true);
      else clearPaneTarget();
      hidePill();
      render();
      return;
    }
    void (async () => {
      await commitFromDom();
      if (cardId) maybeFireDone(cardId, fromListId);
    })();
  }

  function beginDrag(e: PointerEvent, type: "card" | "list", el: HTMLElement) {
    if (e.button !== 0) return;
    dragged = false;
    drag = { type, el, startX: e.clientX, startY: e.clientY, pid: e.pointerId, started: false, overPane: false };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  /** Rebuild board (list order + each list's cards) from the current DOM order.
   *  Called on dragend so a live-reordered DOM becomes the source of truth —
   *  applied onto the freshest board.json copy (see applyDomOrder for how
   *  mid-drag agent edits are kept). */
  async function commitFromDom(): Promise<void> {
    if (!root) return;
    const order: { id: string; cardIds: string[] }[] = [];
    root.querySelectorAll<HTMLElement>(".kb-list").forEach((listNode) => {
      if (!listNode.dataset.list) return;
      const cardIds: string[] = [];
      listNode.querySelectorAll<HTMLElement>(".kb-card").forEach((cardNode) => {
        if (cardNode.dataset.card) cardIds.push(cardNode.dataset.card);
      });
      order.push({ id: listNode.dataset.list, cardIds });
    });
    await withBoard((b) => applyDomOrder(b, order));
  }

  /** First non-dragging card in `host` whose vertical midpoint is below `y`. */
  function cardAfter(host: HTMLElement, y: number): HTMLElement | null {
    const cards = [...host.querySelectorAll<HTMLElement>(".kb-card:not(.dragging)")];
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (y < r.top + r.height / 2) return c;
    }
    return null;
  }

  const findCard = (id: string) => findCardIn(board, id);

  // ---------- mutations ----------
  function addList(title: string) {
    const t = title.trim();
    if (!t) return;
    void withBoard((b) => {
      b.lists.push({ id: uid("l"), title: t, cards: [] });
    });
  }
  function renameList(id: string, title: string) {
    const t = title.trim();
    void withBoard((b) => {
      const list = b.lists.find((l) => l.id === id);
      if (list && t) list.title = t;
    });
  }
  function deleteList(id: string) {
    void withBoard((b) => {
      b.lists = b.lists.filter((l) => l.id !== id);
    });
  }
  function addCard(listId: string, title: string) {
    const t = title.trim();
    if (!t) return;
    void withBoard((b) => {
      b.lists.find((l) => l.id === listId)?.cards.push(mkCard(t));
    });
  }
  function patchCard(id: string, patch: Partial<Card>) {
    void withBoard((b) => {
      const found = findCardIn(b, id);
      if (found) Object.assign(found.card, patch);
    });
  }
  function deleteCard(id: string) {
    openCardId = null;
    void withBoard((b) => {
      const found = findCardIn(b, id);
      if (found) found.list.cards.splice(found.idx, 1);
    });
  }

  const DOING_TITLE = "Doing";
  /** Record who a card is dispatched to; optionally pull it into Doing. */
  function assignCard(cardId: string, name: string | undefined, moveToDoing: boolean): void {
    void withBoard((b) => {
      const found = findCardIn(b, cardId);
      if (!found) return;
      found.card.assignee = name;
      if (moveToDoing && found.list.title.toLowerCase() !== DOING_TITLE.toLowerCase()) {
        const doing = findOrCreateListIn(b, DOING_TITLE);
        found.list.cards.splice(found.idx, 1);
        doing.cards.push(found.card);
      }
    });
  }

  // ---------- card face ----------
  function cardFace(card: Card, listId: string): HTMLElement {
    const node = el("article", "kb-card");
    node.dataset.card = card.id;
    node.dataset.list = listId;

    const labels = card.labels.length
      ? `<div class="kb-labels">${card.labels
          .map((k) => `<span class="kb-label" style="background:${labelHex(k)}"></span>`)
          .join("")}</div>`
      : "";
    const done = card.checklist.filter((i) => i.done).length;
    const badges: string[] = [];
    if (card.due) {
      const d = fmtDue(card.due);
      badges.push(
        `<span class="kb-badge due${d.overdue ? " over" : d.soon ? " soon" : ""}">` +
          `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${d.label}</span>`,
      );
    }
    if (card.checklist.length) {
      badges.push(
        `<span class="kb-badge${done === card.checklist.length ? " ok" : ""}">` +
          `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>${done}/${card.checklist.length}</span>`,
      );
    }
    if (card.desc.trim()) {
      badges.push(
        `<span class="kb-badge"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg></span>`,
      );
    }

    const doneFooter = card.done
      ? `<div class="kb-done">` +
        `<span class="kb-done-tag">✓ done</span>` +
        card.done.files
          .slice(0, 5)
          .map(
            (f) =>
              `<button class="kb-file" data-f="${enc(f)}" title="${enc(f)}">${enc(fileBase(f))}</button>`,
          )
          .join("") +
        (card.done.files.length > 5
          ? `<button class="kb-file kb-diff">+${card.done.files.length - 5}</button>`
          : "") +
        `<button class="kb-file kb-diff">diff</button>` +
        `</div>`
      : "";

    const assignee = card.assignee
      ? `<button class="kb-assignee" title="Focus this agent's pane">⚡ ${enc(card.assignee)}</button>`
      : "";

    node.innerHTML =
      labels +
      `<span class="kb-card-title">${enc(card.title)}</span>` +
      assignee +
      (badges.length ? `<div class="kb-badges">${badges.join("")}</div>` : "") +
      doneFooter;

    node.addEventListener("pointerdown", (e) => {
      // chips aren't drag handles
      if ((e.target as HTMLElement).closest(".kb-done, .kb-assignee")) return;
      beginDrag(e, "card", node);
    });
    // A real drag sets `dragged`, which suppresses this click-to-open.
    node.addEventListener("click", (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>(".kb-assignee");
      if (chip) {
        e.stopPropagation();
        const agent = listAgents().find((a) => a.name === card.assignee);
        if (agent) focusPane(agent.id);
        return;
      }
      const fileBtn = (e.target as HTMLElement).closest<HTMLElement>(".kb-file");
      if (fileBtn) {
        e.stopPropagation();
        if (fileBtn.classList.contains("kb-diff")) openDiff();
        else if (card.done && fileBtn.dataset.f)
          openFileInPanel(`${card.done.repoRoot}\\${fileBtn.dataset.f}`);
        return;
      }
      if (!dragged) openCard(card.id);
    });
    return node;
  }

  // ---------- list ----------
  function listEl(list: List, index: number): HTMLElement {
    const col = el("section", "kb-list");
    col.dataset.list = list.id;
    col.dataset.idx = String(index);

    const head = el("header", "kb-list-h");
    head.innerHTML =
      `<span class="kb-list-t" title="Rename list">${enc(list.title)}</span>` +
      `<span class="kb-list-n">${list.cards.length}</span>` +
      `<button class="kb-list-x" title="Delete list" aria-label="Delete list"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m1 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>`;
    // Pointerdown on the header (but not the delete button) starts a list drag.
    head.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement;
      // not from the delete button, and not while renaming (the inline input)
      if (t.closest(".kb-list-x") || t.closest(".kb-list-edit")) return;
      beginDrag(e, "list", col);
    });
    head.querySelector(".kb-list-t")?.addEventListener("click", () => {
      if (!dragged) startListRename(head, list);
    });
    head.querySelector(".kb-list-x")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!list.cards.length || confirm(`Delete list "${list.title}" and its ${list.cards.length} card(s)?`))
        deleteList(list.id);
    });
    col.appendChild(head);

    const cardsHost = el("div", "kb-cards");
    list.cards.forEach((c) => cardsHost.appendChild(cardFace(c, list.id)));
    col.appendChild(cardsHost);

    // add-card composer
    const composer = el("div", "kb-composer");
    composer.innerHTML =
      `<textarea class="kb-new" rows="1" placeholder="+ Add a card"></textarea>` +
      `<div class="kb-composer-acts" hidden><button class="kb-add-btn">Add card</button></div>`;
    const ta = composer.querySelector("textarea") as HTMLTextAreaElement;
    const acts = composer.querySelector(".kb-composer-acts") as HTMLElement;
    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    };
    ta.addEventListener("focus", () => {
      acts.hidden = false;
    });
    ta.addEventListener("input", grow);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (ta.value.trim()) addCard(list.id, ta.value);
      } else if (e.key === "Escape") {
        ta.value = "";
        ta.blur();
        acts.hidden = true;
      }
    });
    composer.querySelector(".kb-add-btn")?.addEventListener("click", () => {
      if (ta.value.trim()) addCard(list.id, ta.value);
    });
    col.appendChild(composer);
    return col;
  }

  function startListRename(head: HTMLElement, list: List) {
    const t = head.querySelector(".kb-list-t") as HTMLElement;
    const input = document.createElement("input");
    input.className = "kb-list-edit";
    input.value = list.title;
    t.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => renameList(list.id, input.value);
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      else if (e.key === "Escape") {
        input.removeEventListener("blur", commit);
        render();
      }
    });
  }

  // ---------- board render ----------
  function render() {
    if (!root) return;
    if (openCardId && findCard(openCardId)) {
      renderDetail();
      return;
    }
    openCardId = null;
    root.replaceChildren();
    if (!ctx) {
      root.appendChild(el("div", "kb-empty", "<p>Open a workspace to start a board.</p>"));
      return;
    }

    const boardEl = el("div", "kb-board");
    board.lists.forEach((l, i) => boardEl.appendChild(listEl(l, i)));

    // "add another list" tile
    const addTile = el("div", "kb-addlist");
    addTile.innerHTML = `<button class="kb-addlist-btn">+ Add a list</button>`;
    addTile.querySelector("button")?.addEventListener("click", () => {
      const input = document.createElement("input");
      input.className = "kb-addlist-in";
      input.placeholder = "List title…";
      addTile.replaceChildren(input);
      input.focus();
      const done = (commit: boolean) => {
        if (commit && input.value.trim()) addList(input.value);
        else render();
      };
      input.addEventListener("blur", () => done(true));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(true);
        else if (e.key === "Escape") {
          input.removeEventListener("blur", () => done(true));
          done(false);
        }
      });
    });
    boardEl.appendChild(addTile);
    root.appendChild(boardEl);
  }

  // ---------- card detail ----------
  function openCard(id: string) {
    openCardId = id;
    renderDetail();
  }

  function renderDetail() {
    if (!root || !openCardId) return;
    const found = findCard(openCardId);
    if (!found) {
      openCardId = null;
      render();
      return;
    }
    const card = found.card;
    root.replaceChildren();
    const view = el("div", "kb-detail");

    const back = el("button", "kb-detail-back", "← Board");
    back.addEventListener("click", () => {
      openCardId = null;
      render();
    });

    const title = document.createElement("textarea");
    title.className = "kb-detail-title";
    title.rows = 1;
    title.value = card.title;
    const growTitle = () => {
      title.style.height = "auto";
      title.style.height = `${title.scrollHeight}px`;
    };
    title.addEventListener("input", growTitle);
    title.addEventListener("blur", () => patchCard(card.id, { title: title.value.trim() || card.title }));
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        title.blur();
      }
    });

    // labels
    const labels = el("div", "kb-section");
    labels.innerHTML = `<span class="kb-sec-l">Labels</span>`;
    const swatches = el("div", "kb-swatches");
    LABELS.forEach((l) => {
      const on = card.labels.includes(l.key);
      const b = el("button", `kb-swatch${on ? " on" : ""}`);
      b.style.background = l.hex;
      b.title = l.name;
      b.innerHTML = on
        ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#0d1014" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 6"/></svg>'
        : "";
      b.addEventListener("click", () => {
        const next = on ? card.labels.filter((k) => k !== l.key) : [...card.labels, l.key];
        patchCard(card.id, { labels: next });
      });
      swatches.appendChild(b);
    });
    labels.appendChild(swatches);

    // due date
    const due = el("div", "kb-section");
    due.innerHTML = `<span class="kb-sec-l">Due date</span>`;
    const dueRow = el("div", "kb-due-row");
    const dueInput = document.createElement("input");
    dueInput.type = "date";
    dueInput.className = "kb-due-in";
    if (card.due) dueInput.value = card.due;
    dueInput.addEventListener("change", () => patchCard(card.id, { due: dueInput.value || null }));
    dueRow.appendChild(dueInput);
    if (card.due) {
      const clear = el("button", "kb-due-clear", "Clear");
      clear.addEventListener("click", () => patchCard(card.id, { due: null }));
      dueRow.appendChild(clear);
    }
    due.appendChild(dueRow);

    // agent assignment + dispatch
    const agentSec = el("div", "kb-section");
    agentSec.innerHTML = `<span class="kb-sec-l">Agent</span>`;
    const agentRow = el("div", "kb-agent-row");
    if (card.assignee) {
      const chip = el("button", "kb-assignee big", `⚡ ${enc(card.assignee)}`);
      chip.title = "Focus this agent's pane";
      chip.addEventListener("click", () => {
        const a = listAgents().find((x) => x.name === card.assignee);
        if (a) focusPane(a.id);
      });
      const clear = el("button", "kb-due-clear", "Unassign");
      clear.addEventListener("click", () => assignCard(card.id, undefined, false));
      agentRow.append(chip, clear);
    }
    const running = listAgents().filter((a) => a.running);
    if (running.length) {
      const sel = document.createElement("select");
      sel.className = "kb-agent-pick";
      sel.innerHTML =
        `<option value="">Send to agent…</option>` +
        running.map((a) => `<option value="${enc(a.id)}">${enc(a.name)}</option>`).join("");
      sel.addEventListener("change", () => {
        const a = running.find((x) => x.id === sel.value);
        if (!a) return;
        if (sendToAgentById(a.id, dispatchPrompt(card), true)) {
          assignCard(card.id, a.name, true);
        }
        sel.value = "";
      });
      agentRow.appendChild(sel);
    } else if (!card.assignee) {
      agentRow.appendChild(el("span", "kb-agent-none", "No running agents"));
    }
    agentSec.appendChild(agentRow);

    // description
    const desc = el("div", "kb-section");
    desc.innerHTML = `<span class="kb-sec-l">Description</span>`;
    const descTa = document.createElement("textarea");
    descTa.className = "kb-desc";
    descTa.rows = 3;
    descTa.placeholder = "Add a more detailed description…";
    descTa.value = card.desc;
    descTa.addEventListener("blur", () => patchCard(card.id, { desc: descTa.value }));
    desc.appendChild(descTa);

    // checklist
    const cl = el("div", "kb-section");
    const total = card.checklist.length;
    const done = card.checklist.filter((i) => i.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    cl.innerHTML =
      `<span class="kb-sec-l">Checklist <em>${done}/${total}</em></span>` +
      `<div class="kb-cl-bar"><span style="width:${pct}%"></span></div>`;
    card.checklist.forEach((item) => {
      const row = el("label", `kb-cl-item${item.done ? " done" : ""}`);
      row.innerHTML =
        `<input type="checkbox" ${item.done ? "checked" : ""}>` +
        `<span class="kb-cl-box"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2 5 8.6 9.5 3.6"/></svg></span>` +
        `<span class="kb-cl-text">${enc(item.text)}</span>` +
        `<button class="kb-cl-x" aria-label="Remove">×</button>`;
      row.querySelector("input")?.addEventListener("change", () => {
        item.done = !item.done;
        patchCard(card.id, { checklist: card.checklist });
      });
      row.querySelector(".kb-cl-x")?.addEventListener("click", (e) => {
        e.preventDefault();
        patchCard(card.id, { checklist: card.checklist.filter((i) => i.id !== item.id) });
      });
      cl.appendChild(row);
    });
    const addItem = el("div", "kb-cl-add");
    addItem.innerHTML = `<input class="kb-cl-in" placeholder="Add an item…" spellcheck="false">`;
    const clIn = addItem.querySelector("input") as HTMLInputElement;
    clIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && clIn.value.trim()) {
        card.checklist.push({ id: uid("i"), text: clIn.value.trim(), done: false });
        patchCard(card.id, { checklist: card.checklist });
      }
    });
    cl.appendChild(addItem);

    const del = el("button", "kb-detail-del", "Delete card");
    del.addEventListener("click", () => {
      if (confirm("Delete this card?")) deleteCard(card.id);
    });

    view.append(back, title, labels, due, agentSec, desc, cl, del);
    root.appendChild(view);
    requestAnimationFrame(growTitle);
  }

  return {
    mount(body: HTMLElement, actions?: HTMLElement) {
      root = el("div", "kb-root");
      body.appendChild(root);
      // Pointer move/up are bound once on the document; pointer capture (set in
      // beginDrag) routes events here even when the cursor leaves the card.
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
      document.addEventListener("pointercancel", onPointerUp);

      // Plan-gate toolbar: ask the agent to plan, pull its plan in, approve back.
      if (actions) {
        const mkBtn = (label: string, title: string, cb: () => void) => {
          const b = el("button", "kb-tool", enc(label)) as HTMLButtonElement;
          b.title = title;
          b.addEventListener("click", cb);
          actions.appendChild(b);
          return b;
        };
        // Two board verbs: plan the work, then run the fleet. (Import dropped —
        // plan.json auto-imports on a watch; Send approved dropped — the
        // Conductor dispatches approved cards now.)
        mkBtn("Plan with AI", "Drop the plan-first rules file + prime the agent", () =>
          void planWithAI(),
        );
        // Capture web is a side utility, not a board verb — demoted to an icon
        // so it stays available without competing with the primary actions.
        const capBtn = mkBtn("", "Screenshot a web URL into .maestro/shots and open it", () =>
          void captureWeb(),
        );
        capBtn.classList.add("kb-tool-icon");
        capBtn.setAttribute("aria-label", "Capture a web page");
        capBtn.innerHTML =
          `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M8 5l1.5-2h5L16 5"/></svg>`;

        // Conductor: cycles Off → Semi → Auto. Semi dispatches approved (To do)
        // cards to free agents; Auto also tops up To do from Proposed. Click
        // when Auto to return to Off (emergency stop).
        const condBtn = mkBtn("", "", () => {
          const next: Record<ConductorMode, ConductorMode> = {
            off: "semi",
            semi: "auto",
            auto: "pipeline",
            pipeline: "off",
          };
          setConductorMode(next[conductorMode]);
        });
        const LABELS_C: Record<ConductorMode, string> = {
          off: "Conductor: Off",
          semi: "Conductor: Semi",
          auto: "Conductor: Auto",
          pipeline: "Conductor: Pipeline",
        };
        const TITLES_C: Record<ConductorMode, string> = {
          off: "Auto-dispatch is off. Click to have the conductor send approved (To do) cards to free agents.",
          semi: "Semi: free agents get the next To-do card automatically. Click for Auto (also approves Proposed).",
          auto: "Auto: also approves Proposed → To do to keep agents fed. Click for Pipeline.",
          pipeline:
            "Pipeline: cards flow To do → Build → Test → Review → Done, each stage handed to a free agent. Click to stop (Off).",
        };
        const paintConductor = () => {
          condBtn.textContent = LABELS_C[conductorMode];
          condBtn.title = TITLES_C[conductorMode];
          condBtn.classList.toggle("on", conductorMode !== "off");
          condBtn.classList.toggle("auto", conductorMode === "auto" || conductorMode === "pipeline");
        };
        setConductorMode = (m: ConductorMode) => {
          conductorMode = m;
          if (ctx) saveJSON(conductorKey(ctx.key), m);
          // Entering pipeline: seed in-flight memory from cards already assigned
          // so a hand-off isn't misread after a restart. Leaving: forget it.
          assignedStage.clear();
          if (m === "pipeline")
            for (const l of board.lists)
              for (const c of l.cards) if (c.assignee) assignedStage.set(c.id, l.title);
          paintConductor();
          if (m !== "off") void conductorTick(); // act immediately, don't wait a tick
        };
        paintConductor();
      }

      // Auto-watch plan.json + done.json so agent writes land on the board.
      if (watchTimer === null)
        watchTimer = window.setInterval(() => {
          void pollPlan();
          void pollDone();
          void pollBoardJson();
          void conductorTick();
        }, 3500);
      render();
    },
    setContext(next: DockContext | null) {
      ctx = next;
      openCardId = null;
      dir = next?.dir ?? null;
      planMtime = 0;
      doneMtime = 0;
      boardMtime = null;
      seen = next ? loadSeen(next.key) : new Set();
      doneSeen = next ? new Set(loadJSON<string[]>(doneSeenKey(next.key), [])) : new Set();
      // Restore this workspace's conductor mode (persisted per folder).
      setConductorMode(next ? loadJSON<ConductorMode>(conductorKey(next.key), "off") : "off");
      board = defaultBoard();
      render();
      if (!ctx) return;
      void (async () => {
        await loadBoardForContext();
        render();
        void importFromFile(); // pull any existing plan for this folder
        void importDone(); // and any already-reported done tasks
        scheduleBoardFile(); // mirror the current board so the agent can read it
      })();
    },
  };
}
