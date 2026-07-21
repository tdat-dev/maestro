// The "New workspace" wizard: folder + recents + saved presets (layout step),
// then a multi-select model picker (agents step) that also doubles as the
// preset builder. Split from main.ts; everything the wizard needs that still
// lives in main.ts (crew persistence, presets, the confirm modal, the old
// spawn modal's own re-render) is injected via configureWizard.

import { pickFolder, programsOnPath } from "./ipc";
import { CLI_PRESETS, expandCrew, type CrewState } from "./crew";
import { TILE_OPTIONS, gridDims, countLabel, gridLabel, distributeCounts, sanitizeCount } from "./wizard";
import { basename } from "./workspaces";
import { getRecents, addRecent } from "./recents";

// Mirrors SavedCrew / Template in main.ts structurally (TS interfaces are
// structural, so these line up with what the injected functions actually
// return/accept without importing back into main.ts).
interface SavedCrew extends CrewState {
  dir: string;
  skipPerms: boolean;
}
interface Template {
  id: string;
  name: string;
  counts: Record<string, number>;
  custom: string;
  customCount: number;
  dir: string;
  skipPerms: boolean;
}

// Same localStorage key main.ts's spawn modal reads/writes — the wizard and
// the old modal share one persisted "last crew" so either one can restore it.
const STORE_KEY = "maestro.crew";

let onLoadCrew: () => SavedCrew = () => ({ counts: {}, custom: "", customCount: 0, dir: "", skipPerms: false });
let onSpawnCrew: (
  crewState: CrewState,
  dir: string | null,
  skipPerms: boolean,
  mode: "new" | "current",
) => Promise<void> = async () => {};
let onLoadTemplates: () => Template[] = () => [];
let onSaveTemplates: (list: Template[]) => void = () => {};
let onTemplateSummary: (t: Template) => string = () => "";
let onConfirmModal: (opts: {
  title: string;
  message: string;
  okLabel?: string;
  dontAsk?: boolean;
  input?: { placeholder?: string; value?: string };
}) => Promise<{ ok: boolean; dontAsk: boolean; value: string }> = async () => ({ ok: false, dontAsk: false, value: "" });
let onRenderCrew: () => void = () => {};

export function configureWizard(deps: {
  loadCrew: () => SavedCrew;
  spawnCrew: (
    crewState: CrewState,
    dir: string | null,
    skipPerms: boolean,
    mode: "new" | "current",
  ) => Promise<void>;
  loadTemplates: () => Template[];
  saveTemplates: (list: Template[]) => void;
  templateSummary: (t: Template) => string;
  confirmModal: (opts: {
    title: string;
    message: string;
    okLabel?: string;
    dontAsk?: boolean;
    input?: { placeholder?: string; value?: string };
  }) => Promise<{ ok: boolean; dontAsk: boolean; value: string }>;
  renderCrew: () => void;
}): void {
  onLoadCrew = deps.loadCrew;
  onSpawnCrew = deps.spawnCrew;
  onLoadTemplates = deps.loadTemplates;
  onSaveTemplates = deps.saveTemplates;
  onTemplateSummary = deps.templateSummary;
  onConfirmModal = deps.confirmModal;
  onRenderCrew = deps.renderCrew;
}

/* ---------------- workspace wizard ---------------- */

// Which preset binaries actually resolve on PATH. Null until the first probe
// lands; filled by refreshCliAvailability() (fire-and-forget, once per wizard /
// spawn-modal open). Presets whose program is missing get grayed out + made
// unselectable in both the wizard and the old spawn modal's crew grids.
let cliAvailable: Record<string, boolean> | null = null;

/** True unless we've confirmed this program is NOT on PATH. Treated as present
 *  while availability is still unknown so nothing flickers/dims prematurely. */
export function isPresetAvailable(program: string): boolean {
  return cliAvailable === null || cliAvailable[program] !== false;
}

/** Batch-probe every preset's binary once and re-render both crew grids when it
 *  lands. Fire-and-forget: failures leave everything treated as available. */
export function refreshCliAvailability(): void {
  const programs = CLI_PRESETS.map((p) => p.program);
  void programsOnPath(programs)
    .then((results) => {
      const map: Record<string, boolean> = {};
      programs.forEach((prog, i) => {
        map[prog] = results[i] ?? true;
      });
      cliAvailable = map;
      // Drop any stale saved selection that points at a now-missing CLI.
      for (const p of CLI_PRESETS) {
        if (!isPresetAvailable(p.program)) wizSel.delete(p.id);
      }
      renderWizCrew();
      onRenderCrew();
    })
    .catch(() => {
      /* probe failed — leave everything as "available" */
    });
}

const WIZ_COUNT_KEY = "maestro.wizCount";
const wizModal = document.getElementById("wizModal") as HTMLElement;
const wizDir = document.getElementById("wizDir") as HTMLInputElement;
const wizCustom = document.getElementById("wizCustom") as HTMLInputElement;
const wizCrewGrid = document.getElementById("wizCrewGrid") as HTMLElement;
const wizCrewTotal = document.getElementById("wizCrewTotal") as HTMLElement;
const wizSpawnLabel = document.getElementById("wizSpawnLabel") as HTMLElement;
const wizSkipPerms = document.getElementById("wizSkipPerms") as HTMLInputElement;
const wizStepLayout = document.getElementById("wizStepLayout") as HTMLElement;
const wizStepAgents = document.getElementById("wizStepAgents") as HTMLElement;
const wizTilesEl = document.getElementById("wizTiles") as HTMLElement;
const wizRecentWrap = document.getElementById("wizRecentWrap") as HTMLElement;
const wizRecentEl = document.getElementById("wizRecent") as HTMLElement;
const wizPresetsWrap = document.getElementById("wizPresetsWrap") as HTMLElement;
const wizPresetsEl = document.getElementById("wizPresets") as HTMLElement;

const FOLDER_SVG =
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const CHEVRON_SVG =
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;

let wizCount = sanitizeCount(localStorage.getItem(WIZ_COUNT_KEY));
let wizStep: "layout" | "agents" = "layout";

function updateTileInfo() {
  const tc = document.getElementById("wizTileCount");
  const tg = document.getElementById("wizTileGrid");
  if (tc) tc.textContent = countLabel(wizCount);
  if (tg) tg.textContent = gridLabel(wizCount);
}

function renderWizTiles() {
  wizTilesEl.replaceChildren();
  for (const n of TILE_OPTIONS) {
    const { cols, rows } = gridDims(n);
    const b = document.createElement("button");
    b.className = "wiz-tile";
    b.dataset.n = String(n);
    b.classList.toggle("on", n === wizCount);
    const cells = Array.from({ length: n }, () => "<i></i>").join("");
    b.innerHTML =
      `<span class="wt-grid" style="--c:${cols};--r:${rows}">${cells}</span>` +
      `<span class="wt-n">${n}</span>`;
    b.addEventListener("click", () => {
      wizCount = n;
      localStorage.setItem(WIZ_COUNT_KEY, String(n));
      wizTilesEl.querySelectorAll<HTMLElement>(".wiz-tile").forEach((t) =>
        t.classList.toggle("on", t.dataset.n === String(n)),
      );
      updateTileInfo();
    });
    wizTilesEl.appendChild(b);
  }
  updateTileInfo();
}

function renderWizRecents() {
  const r = getRecents();
  if (r.length === 0) {
    wizRecentWrap.hidden = true;
    return;
  }
  wizRecentWrap.hidden = false;
  const cnt = document.getElementById("wizRecentCount");
  if (cnt) cnt.textContent = String(r.length);
  wizRecentEl.replaceChildren();
  for (const dir of r) {
    const b = document.createElement("button");
    b.className = "wiz-recent-card";
    b.title = dir;
    const ic = document.createElement("span");
    ic.className = "wr-ic";
    ic.innerHTML = FOLDER_SVG;
    const meta = document.createElement("span");
    meta.className = "wr-meta";
    const name = document.createElement("b");
    name.textContent = basename(dir) || dir;
    const full = document.createElement("span");
    full.textContent = dir;
    meta.append(name, full);
    const go = document.createElement("span");
    go.className = "wr-go";
    go.innerHTML = CHEVRON_SVG;
    b.append(ic, meta, go);
    b.addEventListener("click", () => {
      wizDir.value = dir;
    });
    wizRecentEl.appendChild(b);
  }
}

// Starter presets shown until the user saves their own. They spawn into the
// folder currently picked in the wizard (no stored dir of their own).
const STARTER_PRESETS: Array<{ name: string; counts: Record<string, number> }> = [
  { name: "Claude ×2", counts: { claude: 2 } },
  { name: "Claude ×4", counts: { claude: 4 } },
  { name: "Claude + Codex", counts: { claude: 1, codex: 1 } },
  { name: "Claude · Codex · Gemini", counts: { claude: 1, codex: 1, gemini: 1 } },
];

// A chip is a div (not a button) so the hover-revealed ✕ can be a real button.
function wizPresetChip(name: string, title: string, total: number, onPick: () => void, onDelete?: () => void): HTMLElement {
  const b = document.createElement("div");
  b.className = "wiz-preset";
  b.title = title;
  b.tabIndex = 0;
  b.setAttribute("role", "button");
  const dots = document.createElement("span");
  dots.className = "wp-dots";
  dots.innerHTML = Array.from({ length: Math.min(total, 9) }, () => "<i></i>").join("");
  const nameEl = document.createElement("span");
  nameEl.className = "wp-name";
  nameEl.textContent = name;
  b.append(dots, nameEl);
  if (onDelete) {
    const x = document.createElement("button");
    x.className = "wp-x";
    x.setAttribute("aria-label", "Delete preset");
    x.textContent = "×";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete();
    });
    b.appendChild(x);
  }
  b.addEventListener("click", onPick);
  b.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick();
    }
  });
  return b;
}

/** One-click launch: close the wizard and spawn `state` into the preset's own
 *  saved folder — so a preset is folder + crew, done. Presets without a folder
 *  (starters) use whatever the wizard's folder field holds. */
export function launchPreset(state: CrewState, presetDir: string, skipPerms: boolean) {
  const dir = presetDir || wizDir.value.trim() || null;
  if (dir) addRecent(dir);
  closeWizard();
  void onSpawnCrew(state, dir, skipPerms, "new");
}

function renderWizPresets() {
  const list = onLoadTemplates();
  wizPresetsWrap.hidden = false;
  const cnt = document.getElementById("wizPresetCount");
  if (cnt) cnt.textContent = list.length ? String(list.length) : "";
  wizPresetsEl.replaceChildren();
  if (list.length > 0) {
    for (const t of list) {
      const state: CrewState = { counts: t.counts, custom: t.custom, customCount: t.customCount };
      const total = expandCrew(state).length;
      wizPresetsEl.appendChild(
        wizPresetChip(t.name, onTemplateSummary(t), total, () => launchPreset(state, t.dir, t.skipPerms), () => {
          onSaveTemplates(onLoadTemplates().filter((x) => x.id !== t.id));
          renderWizPresets();
        }),
      );
    }
  } else {
    for (const p of STARTER_PRESETS) {
      const state: CrewState = { counts: p.counts, custom: "", customCount: 0 };
      const total = expandCrew(state).length;
      wizPresetsEl.appendChild(
        wizPresetChip(p.name, `${p.name} — launches in the folder above`, total, () => launchPreset(state, "", false)),
      );
    }
  }
  const add = document.createElement("button");
  add.className = "wiz-preset new";
  add.textContent = "+ NEW";
  add.title = "Build a preset: pick models on the next step, then save it";
  add.addEventListener("click", () => {
    wizPresetMode = true;
    setWizStep("agents");
  });
  wizPresetsEl.appendChild(add);
}

// The Agents step is a multi-select: tap models on/off, no steppers. The
// terminal count picked on the Layout step is split between the selected ids
// (custom command included while it has text) via distributeCounts.
let wizSel = new Set<string>(["claude"]);

/** Selected ids in CLI_PRESETS order; the custom command (when filled) last. */
function wizSelectedIds(): string[] {
  const ids = CLI_PRESETS.filter((p) => wizSel.has(p.id)).map((p) => p.id);
  if (wizSel.has("custom") && wizCustom.value.trim()) ids.push("custom");
  return ids;
}

/** The wizard's effective crew: tile count split across the selection. */
function wizCrewState(): CrewState {
  const counts = distributeCounts(wizCount, wizSelectedIds());
  const customCount = counts["custom"] ?? 0;
  delete counts["custom"];
  return { counts, custom: wizCustom.value, customCount };
}

function renderWizCrew() {
  if (!wizCrewGrid) return;
  const dist = distributeCounts(wizCount, wizSelectedIds());
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (wizCrewTotal) wizCrewTotal.textContent = String(total);
  if (wizSpawnLabel) wizSpawnLabel.textContent = total > 0 ? `Spawn ${total} agent${total > 1 ? "s" : ""}` : "Spawn";
  const sp = document.getElementById("wizSpawn") as HTMLButtonElement | null;
  if (sp) sp.disabled = total === 0;
  const ac = document.getElementById("wizAgentCount");
  if (ac) ac.textContent = countLabel(wizCount);
  wizCrewGrid.querySelectorAll<HTMLElement>(".crew-card").forEach((card) => {
    const id = card.dataset.id!;
    const preset = CLI_PRESETS.find((p) => p.id === id);
    const missing = preset ? !isPresetAvailable(preset.program) : false;
    const on = !missing && wizSel.has(id);
    card.classList.toggle("missing", missing);
    card.classList.toggle("on", on);
    if (missing && preset) card.title = `${preset.program} not found on PATH`;
    else card.removeAttribute("title");
    const share = card.querySelector<HTMLElement>("[data-share]");
    if (share) {
      share.hidden = missing || !on;
      share.textContent = `×${dist[id] ?? 0}`;
    }
  });
  const cs = document.getElementById("wizCustomShare");
  if (cs) {
    const on = wizSel.has("custom") && wizCustom.value.trim() !== "";
    cs.hidden = !on;
    cs.textContent = `×${dist["custom"] ?? 0}`;
  }
}

function buildWizCrewGrid() {
  wizCrewGrid.replaceChildren();
  for (const p of CLI_PRESETS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "crew-card pick";
    card.dataset.id = p.id;
    const cmd = [p.program, ...p.args].join(" ");
    card.innerHTML = `
      <div class="cc-meta">
        <span class="cc-name">${p.label}</span>
        <span class="cc-badge" title="${cmd}">${cmd}</span>
      </div>
      <span class="wiz-share" data-share hidden>×0</span>`;
    card.addEventListener("click", () => {
      // A CLI that isn't installed can't be selected.
      if (!isPresetAvailable(p.program)) return;
      if (wizSel.has(p.id)) wizSel.delete(p.id);
      else wizSel.add(p.id);
      renderWizCrew();
    });
    wizCrewGrid.appendChild(card);
  }
}

// "+ NEW" preset flow: the Agents step doubles as the preset builder. In
// preset mode the Spawn button hides and "Save preset" becomes the primary CTA.
let wizPresetMode = false;

function setWizStep(step: "layout" | "agents") {
  wizStep = step;
  if (step === "layout") wizPresetMode = false;
  wizStepLayout.hidden = step !== "layout";
  wizStepAgents.hidden = step !== "agents";
  const onLayout = step === "layout";
  (document.getElementById("wizNext") as HTMLElement).hidden = !onLayout;
  (document.getElementById("wizNoAi") as HTMLElement).hidden = !onLayout;
  (document.getElementById("wizSpawn") as HTMLElement).hidden = onLayout || wizPresetMode;
  const saveTpl = document.getElementById("wizSaveTpl") as HTMLElement;
  saveTpl.hidden = onLayout;
  saveTpl.classList.toggle("wiz-next", wizPresetMode);
  saveTpl.classList.toggle("wiz-ghost", !wizPresetMode);
  // The step doubles as the preset builder — retitle it accordingly.
  const heroH = wizStepAgents.querySelector<HTMLElement>(".wiz-hero h1");
  const heroP = wizStepAgents.querySelector<HTMLElement>(".wiz-hero p");
  if (heroH) heroH.textContent = wizPresetMode ? "Build a preset" : "Add AI agents";
  if (heroP)
    heroP.textContent = wizPresetMode
      ? "Pick the models (and count above) for this preset, then hit Save preset."
      : "Select one or more models — your terminals are split between them.";
  const stepLayout = document.querySelector<HTMLElement>('.wiz-steps .wstep[data-step="layout"]');
  const stepAgents = document.querySelector<HTMLElement>('.wiz-steps .wstep[data-step="agents"]');
  const stepStart = document.querySelector<HTMLElement>('.wiz-steps .wstep[data-step="start"]');
  if (stepStart) stepStart.classList.add("done");
  if (stepLayout) {
    stepLayout.classList.toggle("on", onLayout);
    stepLayout.classList.toggle("done", !onLayout);
  }
  if (stepAgents) stepAgents.classList.toggle("on", !onLayout);
  if (!onLayout) renderWizCrew();
}

export function openWizard(dir?: string) {
  const saved = onLoadCrew();
  wizDir.value = dir ?? saved.dir;
  wizCustom.value = saved.custom;
  wizSkipPerms.checked = saved.skipPerms;
  wizCount = sanitizeCount(localStorage.getItem(WIZ_COUNT_KEY));
  // Last session's crew → which models start selected (default: Claude).
  wizSel = new Set(CLI_PRESETS.filter((p) => (saved.counts[p.id] ?? 0) > 0).map((p) => p.id));
  if (saved.customCount > 0 && saved.custom.trim()) wizSel.add("custom");
  if (wizSel.size === 0) wizSel.add("claude");
  renderWizTiles();
  renderWizRecents();
  renderWizPresets();
  renderWizCrew();
  setWizStep("layout");
  wizModal.classList.add("open");
  wizDir.focus();
  wizDir.select();
  refreshCliAvailability(); // gray out CLIs that aren't installed
}

function closeWizard() {
  wizModal.classList.remove("open");
}

async function spawnFromWizard() {
  const dir = wizDir.value.trim() || null;
  const skipPerms = wizSkipPerms.checked;
  const state = wizCrewState();
  if (expandCrew(state).length === 0) return;
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      counts: state.counts,
      custom: state.custom,
      customCount: state.customCount,
      dir: dir ?? "",
      skipPerms,
    }),
  );
  if (dir) addRecent(dir);
  closeWizard();
  await onSpawnCrew(state, dir, skipPerms, "new");
}

/** Save the wizard's current setup (tile count split over the selected models)
 *  as a named preset. Shared by the Agents-step button and the + NEW chip. */
async function saveWizTemplate() {
  const dir = wizDir.value.trim();
  const skipPerms = wizSkipPerms.checked;
  const state = wizCrewState();
  if (expandCrew(state).length === 0) {
    setWizStep("agents"); // nothing selected — let the user compose a crew first
    return;
  }
  const defName = (dir ? basename(dir) : "") || "Crew preset";
  const summary = onTemplateSummary({ id: "", name: "", counts: state.counts, custom: state.custom, customCount: state.customCount, dir, skipPerms });
  const { ok, value } = await onConfirmModal({
    title: "Save preset",
    message: dir
      ? `Save "${summary}" as a one-click preset — it remembers this folder, so later one tap spawns everything.`
      : `Save "${summary}" as a one-click preset. Tip: pick a working folder first and the preset will remember it.`,
    okLabel: "Save",
    input: { placeholder: "Preset name", value: defName },
  });
  if (!ok) return;
  const name = value.trim() || defName;
  const tpl: Template = {
    id: "tpl-" + Math.random().toString(36).slice(2, 9),
    name,
    counts: { ...state.counts },
    custom: state.custom,
    customCount: state.customCount,
    dir,
    skipPerms,
  };
  onSaveTemplates([...onLoadTemplates(), tpl]);
  renderWizPresets();
  // Came here via "+ NEW" → hop back to the layout step to show the new chip.
  if (wizPresetMode) setWizStep("layout");
}

/** Wire every wizard control. Call once at startup (after configureWizard). */
export function initWizard(): void {
  buildWizCrewGrid();

  // Typing a custom command opts it into the split; clearing it opts out.
  wizCustom.addEventListener("input", () => {
    if (wizCustom.value.trim()) wizSel.add("custom");
    else wizSel.delete("custom");
    renderWizCrew();
  });

  document.getElementById("wizBrowse")?.addEventListener("click", async () => {
    const picked = await pickFolder(wizDir.value || undefined);
    if (picked) {
      wizDir.value = picked;
      wizDir.focus();
    }
  });

  document.getElementById("wizBack")?.addEventListener("click", () => {
    if (wizStep === "agents") setWizStep("layout");
    else closeWizard();
  });

  document.getElementById("wizNext")?.addEventListener("click", () => setWizStep("agents"));

  document.getElementById("wizNoAi")?.addEventListener("click", () => {
    const dir = wizDir.value.trim() || null;
    if (dir) addRecent(dir);
    closeWizard();
    void onSpawnCrew({ counts: { powershell: wizCount }, custom: "", customCount: 0 }, dir, false, "new");
  });

  document.getElementById("wizSpawn")?.addEventListener("click", () => void spawnFromWizard());

  document.getElementById("wizSaveTpl")?.addEventListener("click", () => void saveWizTemplate());

  document.getElementById("wizClose")?.addEventListener("click", closeWizard);
  wizModal.addEventListener("mousedown", (e) => {
    if (e.target === wizModal) closeWizard();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && wizModal.classList.contains("open")) closeWizard();
  });
}
