/* Kanban board — a Trello-style board scoped to each workspace folder. Editable
 * lists (add / rename / delete / drag-reorder), cards you drag within and across
 * lists with a live drop placeholder, and a card detail view with description,
 * colour labels, due date, and a checklist. State lives in localStorage keyed by
 * the active workspace. Rendered inside a dock panel; see dock.ts. */

import { loadJSON, saveJSON, type DockContext } from "./dockstore";
import { fsReadFile, fsStat, fsWriteFile, fsCreateFile, fsCreateDir } from "./ipc";
import { sendToAgent } from "./agentbridge";
import { parsePlan, type PlanTask } from "./planparse";

/* ---- agent ⇄ board plan gate ---- */
const PLAN_REL = ".maestro\\plan.json";
const RULES_DIR = ".maestro";
const RULES_REL = ".maestro\\AGENTS.md";
const PROPOSED_TITLE = "Proposed";

// Written into the workspace so every agent session follows plan-first.
const RULES_TEXT = `# Maestro — plan-first protocol

For ANY task in this workspace, do NOT implement immediately.

1. Break the work into small, concrete subtasks.
2. Write them to \`.maestro/plan.json\` as a JSON array, e.g.
   [{"title":"short task","desc":"one-line detail","label":"blue"}]
   (label is optional: green | yellow | orange | red | purple | blue)
3. STOP and wait. The tasks appear on the Maestro board for review.
4. Only implement the tasks I confirm as approved.
`;

// Typed into the focused agent; the user appends their actual task, then Enter.
const PLAN_PRIMER =
  "Read .maestro/AGENTS.md and follow its plan-first protocol — write the breakdown to .maestro/plan.json, then stop. Task: ";

interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}
interface Card {
  id: string;
  title: string;
  desc: string;
  labels: string[]; // label colour keys
  due: string | null; // ISO date (yyyy-mm-dd) or null
  checklist: ChecklistItem[];
}
interface List {
  id: string;
  title: string;
  cards: Card[];
}
interface Board {
  lists: List[];
}

/* Trello-flavoured label palette, tuned to the app's dark surfaces. */
const LABELS: { key: string; hex: string; name: string }[] = [
  { key: "green", hex: "#3ad29f", name: "Green" },
  { key: "yellow", hex: "#e6c84a", name: "Yellow" },
  { key: "orange", hex: "#e0913a", name: "Orange" },
  { key: "red", hex: "#ff6b6b", name: "Red" },
  { key: "purple", hex: "#b18cf0", name: "Purple" },
  { key: "blue", hex: "#5ec2f0", name: "Blue" },
];
const labelHex = (k: string) => LABELS.find((l) => l.key === k)?.hex ?? "#7d8b99";

const keyFor = (ctxKey: string) => `maestro.kanban.v2.${ctxKey}`;
const legacyKeyFor = (ctxKey: string) => `maestro.kanban.v1.${ctxKey}`;

let idSeq = 0;
function uid(p: string): string {
  idSeq += 1;
  return `${p}${Date.now().toString(36)}${idSeq}`;
}

const enc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function el(tag: string, cls?: string, html?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function defaultBoard(): Board {
  return {
    lists: [
      { id: uid("l"), title: "To do", cards: [] },
      { id: uid("l"), title: "Doing", cards: [] },
      { id: uid("l"), title: "Done", cards: [] },
    ],
  };
}

/** Bring any stored shape up to the current Board model — including the v1
 *  {todo,doing,done} format so existing boards survive the upgrade. */
function normalize(raw: unknown, ctxKey: string): Board {
  const r = raw as Record<string, unknown> | null;
  if (r && Array.isArray((r as { lists?: unknown }).lists)) {
    const lists = (r.lists as List[]).map((l) => ({
      id: l.id || uid("l"),
      title: typeof l.title === "string" ? l.title : "List",
      cards: Array.isArray(l.cards) ? l.cards.map(normalizeCard) : [],
    }));
    return { lists };
  }
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

function normalizeCard(c: Partial<Card>): Card {
  return {
    id: c.id || uid("c"),
    title: typeof c.title === "string" ? c.title : "",
    desc: typeof c.desc === "string" ? c.desc : "",
    labels: Array.isArray(c.labels) ? c.labels : [],
    due: typeof c.due === "string" ? c.due : null,
    checklist: Array.isArray(c.checklist) ? c.checklist : [],
  };
}
function mkCard(title: string): Card {
  return { id: uid("c"), title, desc: "", labels: [], due: null, checklist: [] };
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
  let watchTimer: number | null = null;
  let seen = new Set<string>(); // task titles already imported (survives deletes)

  const seenKey = (k: string) => `maestro.kanban.planseen.${k}`;
  const loadSeen = (k: string) => new Set(loadJSON<string[]>(seenKey(k), []));
  const saveSeen = () => {
    if (ctx) saveJSON(seenKey(ctx.key), [...seen]);
  };

  function findOrCreateList(title: string): List {
    let list = board.lists.find((l) => l.title.toLowerCase() === title.toLowerCase());
    if (!list) {
      list = { id: uid("l"), title, cards: [] };
      board.lists.unshift(list); // Proposed sits first
    }
    return list;
  }
  const boardHasTitle = (title: string) =>
    board.lists.some((l) => l.cards.some((c) => c.title.toLowerCase() === title.toLowerCase()));

  /** Import agent-proposed tasks into the Proposed list (skipping ones already
   *  imported or already on the board). Returns how many were added. */
  function importProposed(tasks: PlanTask[]): number {
    const list = findOrCreateList(PROPOSED_TITLE);
    let added = 0;
    for (const t of tasks) {
      const key = t.title.toLowerCase();
      if (seen.has(key) || boardHasTitle(t.title)) continue;
      const card = mkCard(t.title);
      if (t.desc) card.desc = t.desc;
      card.labels = [t.label ?? "blue"];
      list.cards.push(card);
      seen.add(key);
      added += 1;
    }
    if (added > 0) {
      saveSeen();
      persist();
      render();
    }
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

  /** Tell the agent which tasks were approved (everything in To do). */
  function sendApproved(): void {
    const todo = board.lists.find((l) => l.title.toLowerCase() === "to do");
    const titles = todo?.cards.map((c) => c.title) ?? [];
    if (titles.length === 0) return;
    const msg =
      "Approved. Implement these tasks now, one at a time, and tell me when each is done:\n" +
      titles.map((t, i) => `${i + 1}. ${t}`).join("\n");
    sendToAgent(msg, true);
  }

  // Drag uses POINTER EVENTS, not HTML5 drag-and-drop. Maestro runs in a Tauri
  // WebView2 window with OS drag-drop enabled (the "drop a file on a pane"
  // feature), which swallows HTML5 dragstart/drop inside the webview. Pointer
  // capture is the pattern that works here (same as the home mascot). We move
  // the real DOM node live as the pointer moves, then rebuild the model from
  // the DOM order on pointerup.
  let drag:
    | { type: "card" | "list"; el: HTMLElement; startX: number; startY: number; pid: number; started: boolean }
    | null = null;
  // True from the moment a real drag starts until the next pointerdown — lets
  // the trailing click after a drag be ignored (so it doesn't open a card or
  // start a rename).
  let dragged = false;

  function persist() {
    if (ctx) saveJSON(keyFor(ctx.key), board);
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

  function onPointerUp() {
    if (!drag) return;
    const { el, pid, started } = drag;
    try {
      el.releasePointerCapture(pid);
    } catch {
      /* ignore */
    }
    drag = null;
    if (started) {
      el.classList.remove("dragging", "list-dragging");
      commitFromDom();
      render();
    }
  }

  function beginDrag(e: PointerEvent, type: "card" | "list", el: HTMLElement) {
    if (e.button !== 0) return;
    dragged = false;
    drag = { type, el, startX: e.clientX, startY: e.clientY, pid: e.pointerId, started: false };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  /** Rebuild board (list order + each list's cards) from the current DOM order.
   *  Called on dragend so a live-reordered DOM becomes the source of truth. */
  function commitFromDom() {
    if (!root) return;
    const cardById = new Map<string, Card>();
    const listById = new Map<string, List>();
    board.lists.forEach((l) => {
      listById.set(l.id, l);
      l.cards.forEach((c) => cardById.set(c.id, c));
    });
    const nextLists: List[] = [];
    root.querySelectorAll<HTMLElement>(".kb-list").forEach((listNode) => {
      const list = listById.get(listNode.dataset.list || "");
      if (!list) return;
      const cards: Card[] = [];
      listNode.querySelectorAll<HTMLElement>(".kb-card").forEach((cardNode) => {
        const c = cardById.get(cardNode.dataset.card || "");
        if (c) cards.push(c);
      });
      list.cards = cards;
      nextLists.push(list);
    });
    if (nextLists.length) board.lists = nextLists;
    persist();
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

  function findCard(id: string): { list: List; idx: number; card: Card } | null {
    for (const list of board.lists) {
      const idx = list.cards.findIndex((c) => c.id === id);
      if (idx >= 0) return { list, idx, card: list.cards[idx] };
    }
    return null;
  }

  // ---------- mutations ----------
  function addList(title: string) {
    const t = title.trim();
    if (!t) return;
    board.lists.push({ id: uid("l"), title: t, cards: [] });
    persist();
    render();
  }
  function renameList(id: string, title: string) {
    const list = board.lists.find((l) => l.id === id);
    if (!list) return;
    const t = title.trim();
    if (t) list.title = t;
    persist();
    render();
  }
  function deleteList(id: string) {
    board.lists = board.lists.filter((l) => l.id !== id);
    persist();
    render();
  }
  function addCard(listId: string, title: string) {
    const t = title.trim();
    if (!t) return;
    board.lists.find((l) => l.id === listId)?.cards.push(mkCard(t));
    persist();
    render();
  }
  function patchCard(id: string, patch: Partial<Card>) {
    const found = findCard(id);
    if (!found) return;
    Object.assign(found.card, patch);
    persist();
    if (openCardId === id) renderDetail();
    else render();
  }
  function deleteCard(id: string) {
    const found = findCard(id);
    if (!found) return;
    found.list.cards.splice(found.idx, 1);
    openCardId = null;
    persist();
    render();
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

    node.innerHTML =
      labels +
      `<span class="kb-card-title">${enc(card.title)}</span>` +
      (badges.length ? `<div class="kb-badges">${badges.join("")}</div>` : "");

    node.addEventListener("pointerdown", (e) => beginDrag(e, "card", node));
    // A real drag sets `dragged`, which suppresses this click-to-open.
    node.addEventListener("click", () => {
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

    view.append(back, title, labels, due, desc, cl, del);
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
        mkBtn("Plan with AI", "Drop the plan-first rules file + prime the agent", () =>
          void planWithAI(),
        );
        mkBtn("Import", "Import tasks from .maestro/plan.json now", () => void importFromFile());
        mkBtn("Send approved", "Tell the agent to implement the To do list", sendApproved);
      }

      // Auto-watch the plan file so an agent write lands on the board on its own.
      if (watchTimer === null) watchTimer = window.setInterval(() => void pollPlan(), 3500);
      render();
    },
    setContext(next: DockContext | null) {
      ctx = next;
      openCardId = null;
      dir = next?.dir ?? null;
      planMtime = 0;
      seen = next ? loadSeen(next.key) : new Set();
      board = ctx ? normalize(loadJSON<unknown>(keyFor(ctx.key), null), ctx.key) : defaultBoard();
      render();
      void importFromFile(); // pull any existing plan for this folder
    },
  };
}
