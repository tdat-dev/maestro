// Spawn-setup modal (the quick "+ Spawn agents" crew picker) + saved crew
// templates. Split from main.ts; workspace/pane creation and a few other
// main-side helpers are injected via configureSpawnModal to avoid a circular
// import.

import { pickFolder, sendInput } from "./ipc";
import {
  CLI_PRESETS,
  expandCrew,
  runLimited,
  effectiveArgs,
  nameForNewPane,
  type CrewState,
  type CliPreset,
} from "./crew";
import { type Workspace, type AgentSpec } from "./panetypes";
import { workspaces, activeWs } from "./appstate";
import { basename } from "./workspaces";
import { addRecent } from "./recents";

let onCreateAgent: (
  ws: Workspace,
  spec: AgentSpec,
  restore?: boolean,
  attach?: { id: string; spawnedAt: number | null },
) => () => Promise<void> = () => async () => {};
let onCreateWorkspace: (dir: string | null, name?: string) => Workspace = () => {
  throw new Error("spawnmodal: configureSpawnModal not called");
};
let onCliLook: (badge: string, label: string) => { color: string; mono: string } = () => ({
  color: "#c6f135",
  mono: "?",
});
let onConfirmModal: (opts: {
  title: string;
  message: string;
  okLabel?: string;
  dontAsk?: boolean;
  input?: { placeholder?: string; value?: string };
}) => Promise<{ ok: boolean; dontAsk: boolean; value: string }> = () =>
  Promise.resolve({ ok: false, dontAsk: false, value: "" });
let onIsPresetAvailable: (program: string) => boolean = () => true;
let onRefreshCliAvailability: () => void = () => {};
let conductorLaws = "";

export function configureSpawnModal(deps: {
  createAgent: (
    ws: Workspace,
    spec: AgentSpec,
    restore?: boolean,
    attach?: { id: string; spawnedAt: number | null },
  ) => () => Promise<void>;
  createWorkspace: (dir: string | null, name?: string) => Workspace;
  cliLook: (badge: string, label: string) => { color: string; mono: string };
  confirmModal: (opts: {
    title: string;
    message: string;
    okLabel?: string;
    dontAsk?: boolean;
    input?: { placeholder?: string; value?: string };
  }) => Promise<{ ok: boolean; dontAsk: boolean; value: string }>;
  isPresetAvailable: (program: string) => boolean;
  refreshCliAvailability: () => void;
  conductorLaws: string;
}): void {
  onCreateAgent = deps.createAgent;
  onCreateWorkspace = deps.createWorkspace;
  onCliLook = deps.cliLook;
  onConfirmModal = deps.confirmModal;
  onIsPresetAvailable = deps.isPresetAvailable;
  onRefreshCliAvailability = deps.refreshCliAvailability;
  conductorLaws = deps.conductorLaws;
}

const STORE_KEY = "maestro.crew";
const MAX_CONCURRENT_BOOT = 3;
const modal = document.getElementById("spawnModal") as HTMLElement;
const mDir = document.getElementById("mDir") as HTMLInputElement;
const mCustom = document.getElementById("mCustom") as HTMLInputElement;
const crewGrid = document.getElementById("crewGrid") as HTMLElement;
const crewTotalEl = document.getElementById("crewTotal") as HTMLElement;
const spawnLabel = document.getElementById("mSpawnLabel") as HTMLElement;
const mSkipPerms = document.getElementById("mSkipPerms") as HTMLInputElement;
const mConductor = document.getElementById("mConductor") as HTMLInputElement | null;

interface SavedCrew extends CrewState {
  dir: string;
  skipPerms: boolean;
}

let crew: CrewState = { counts: {}, custom: "", customCount: 0 };

export function loadCrew(): SavedCrew {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return {
      counts: s.counts && typeof s.counts === "object" ? s.counts : {},
      custom: typeof s.custom === "string" ? s.custom : "",
      customCount: Number.isFinite(s.customCount) ? s.customCount : 0,
      dir: typeof s.dir === "string" ? s.dir : "",
      skipPerms: s.skipPerms === true,
    };
  } catch {
    return { counts: {}, custom: "", customCount: 0, dir: "", skipPerms: false };
  }
}

export function renderCrew() {
  // Conductor converts the first agent (doesn't add) — with no workers it's a
  // lone conductor, so total is at least 1 when the toggle is on.
  const workers = expandCrew(crew).length;
  const total = mConductor?.checked && workers === 0 ? 1 : workers;
  crewTotalEl.textContent = String(total);
  spawnLabel.textContent = total > 0 ? `Spawn ${total} agent${total > 1 ? "s" : ""}` : "Spawn";
  (document.getElementById("mSpawn") as HTMLButtonElement).disabled = total === 0;
  crewGrid.querySelectorAll<HTMLElement>(".crew-card").forEach((card) => {
    const id = card.dataset.id!;
    const preset = CLI_PRESETS.find((p) => p.id === id);
    const missing = preset ? !onIsPresetAvailable(preset.program) : false;
    card.classList.toggle("missing", missing);
    if (missing && preset) card.title = `${preset.program} not found on PATH`;
    else card.removeAttribute("title");
    const n = crew.counts[id] ?? 0;
    card.classList.toggle("on", n > 0);
    const nEl = card.querySelector<HTMLElement>("[data-n]");
    if (nEl) nEl.textContent = String(n);
  });
  const cn = document.querySelector<HTMLElement>("[data-custom-n]");
  if (cn) cn.textContent = String(crew.customCount);
}

function buildCrewGrid() {
  crewGrid.replaceChildren();
  for (const p of CLI_PRESETS) {
    const card = document.createElement("div");
    card.className = "crew-card";
    card.dataset.id = p.id;
    const cmd = [p.program, ...p.args].join(" ");
    card.innerHTML = `
      <div class="cc-meta">
        <span class="cc-name">${p.label}</span>
        <span class="cc-badge" title="${cmd}">${cmd}</span>
      </div>
      <div class="stepper">
        <button type="button" data-dec aria-label="One fewer">−</button>
        <span class="n" data-n>0</span>
        <button type="button" data-inc aria-label="One more">+</button>
      </div>`;
    card.querySelector("[data-dec]")?.addEventListener("click", () => {
      crew.counts[p.id] = Math.max(0, (crew.counts[p.id] ?? 0) - 1);
      renderCrew();
    });
    card.querySelector("[data-inc]")?.addEventListener("click", () => {
      if (!onIsPresetAvailable(p.program)) return; // can't add an uninstalled CLI
      crew.counts[p.id] = Math.min(32, (crew.counts[p.id] ?? 0) + 1);
      renderCrew();
    });
    crewGrid.appendChild(card);
  }
}

// "new" → spawn into a fresh workspace tab; "current" → add to the active one.
let modalTarget: "new" | "current" = "new";
export function openModal(mode: "new" | "current" = "new") {
  modalTarget = mode;
  const saved = loadCrew();
  crew = { counts: saved.counts, custom: saved.custom, customCount: saved.customCount };
  mDir.value = mode === "current" && activeWs ? activeWs.dir ?? "" : saved.dir;
  mCustom.value = crew.custom;
  mSkipPerms.checked = saved.skipPerms;
  renderCrew();
  modal.classList.add("open");
  mDir.focus();
  mDir.select();
  onRefreshCliAvailability(); // gray out CLIs that aren't installed
}
function closeModal() {
  modal.classList.remove("open");
}

/** Core spawn: expand a crew → choose/create a workspace → mount & boot the
 *  fleet (concurrency-limited). Shared by the spawn modal and saved templates. */
export async function spawnCrew(
  crewState: CrewState,
  dir: string | null,
  skipPerms: boolean,
  mode: "new" | "current",
  conductor = false,
): Promise<void> {
  const fleet = expandCrew(crewState);
  // Conductor CONVERTS the first agent — it doesn't add one. With no workers
  // picked, spawn a single Claude conductor.
  if (fleet.length === 0 && conductor) fleet.push(CLI_PRESETS.find((x) => x.id === "claude")!);
  if (fleet.length === 0) return;

  // Spawn into the active workspace, or a brand-new tab.
  const ws = mode === "current" && activeWs ? activeWs : onCreateWorkspace(dir);
  if (mode === "current" && activeWs && !activeWs.dir && dir) activeWs.dir = dir;

  // The first agent becomes the conductor when the toggle is on (same CLI as
  // your first pick). Name the rest per CLI: "Claude Code #1", "#2"; plain when
  // there is only one worker of that CLI.
  const conductorIdx = conductor ? 0 : -1;
  // Each pane gets a short persona name (Ana, Bob, …), unique in this workspace;
  // the conductor keeps the "Conductor" label. Renameable from the title bar.
  const taken: string[] = [...ws.panes.values()].map((x) => x.spec.name);
  let conductorIsClaude = false;

  const boots = fleet.map((p: CliPreset, i) => {
    if (i === conductorIdx) {
      conductorIsClaude = p.badge === "claude";
      taken.push("Conductor");
      return onCreateAgent(ws, {
        program: p.program,
        args: effectiveArgs(p, skipPerms),
        cwd: dir,
        name: "Conductor",
        badge: p.badge,
        role: "conductor",
        ...onCliLook(p.badge, p.label),
      });
    }
    const name = nameForNewPane(p.badge, taken);
    taken.push(name);
    return onCreateAgent(ws, {
      program: p.program,
      args: effectiveArgs(p, skipPerms),
      cwd: dir,
      name,
      badge: p.badge,
      role: p.role,
      ...onCliLook(p.badge, p.label),
    });
  });

  // Boot through a concurrency-limited queue so many heavy CLIs don't all start
  // at once and spike the CPU (panes already appeared above as "queued…").
  await runLimited(boots, MAX_CONCURRENT_BOOT);

  // A Claude conductor gets CONDUCTOR_LAWS via --append-system-prompt at launch.
  // Other CLIs have no such flag, so prime the conductor by typing the same
  // instructions once it reaches its prompt.
  if (conductor && !conductorIsClaude) {
    window.setTimeout(() => {
      const pane = [...ws.panes.values()].find((x) => x.spec.name === "Conductor");
      if (pane && pane.running) void sendInput(pane.id, conductorLaws + "\r").catch(() => {});
    }, 3500);
  }
}

/** A conductor agent asked (via the maestro-mcp agent_spawn tool) to grow its
 *  crew. Spawn the worker(s) into the SAME open workspace (so they share the
 *  board + fleet), with names unique in that workspace, and — if a task was
 *  given — type it into each once they've had a moment to reach their prompt. */
export async function spawnForConductor(
  dir: string,
  req: { cli: string; task: string | null; count: number },
): Promise<void> {
  const ws = [...workspaces.values()].find((w) => w.dir === dir);
  if (!ws) return; // the requesting agent's workspace isn't open anymore
  const preset = CLI_PRESETS.find((p) => p.id === req.cli);
  const state: CrewState = preset
    ? { counts: { [req.cli]: req.count }, custom: "", customCount: 0 }
    : { counts: {}, custom: req.cli, customCount: req.count };
  const fleet = expandCrew(state);
  if (!fleet.length) return;
  const newNames: string[] = [];
  const boots = fleet.map((p) => {
    const base = p.shell && dir ? basename(dir) : p.label;
    const taken = new Set([...ws.panes.values()].map((x) => x.spec.name));
    let name = base;
    for (let n = 2; taken.has(name); n += 1) name = `${base} #${n}`;
    newNames.push(name);
    return onCreateAgent(ws, {
      program: p.program,
      args: effectiveArgs(p, false),
      cwd: dir,
      name,
      badge: p.badge,
      ...onCliLook(p.badge, p.label),
    });
  });
  await runLimited(boots, MAX_CONCURRENT_BOOT);
  const task = req.task;
  if (task) {
    // The CLI needs a few seconds to reach its prompt before it accepts input.
    window.setTimeout(() => {
      for (const name of newNames) {
        const pane = [...ws.panes.values()].find((x) => x.spec.name === name);
        if (pane && pane.running) void sendInput(pane.id, task + "\r").catch(() => {});
      }
    }, 3500);
  }
}

async function spawnFromModal() {
  const dir = mDir.value.trim() || null;
  crew.custom = mCustom.value;
  const skipPerms = mSkipPerms.checked;
  if (expandCrew(crew).length === 0) return;

  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      counts: crew.counts,
      custom: crew.custom,
      customCount: crew.customCount,
      dir: dir ?? "",
      skipPerms,
    }),
  );
  if (dir) addRecent(dir);
  closeModal();

  await spawnCrew(crew, dir, skipPerms, modalTarget, mConductor?.checked ?? false);
}

/* ---------------- crew templates ---------------- */

export interface Template {
  id: string;
  name: string;
  counts: Record<string, number>;
  custom: string;
  customCount: number;
  dir: string;
  skipPerms: boolean;
}

const TEMPLATES_KEY = "maestro.templates";

export function loadTemplates(): Template[] {
  try {
    const v = JSON.parse(localStorage.getItem(TEMPLATES_KEY) || "[]");
    return Array.isArray(v) ? (v as Template[]) : [];
  } catch {
    return [];
  }
}
export function saveTemplates(list: Template[]) {
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
}

/** Human-readable summary of a template's crew, e.g.
 *  "2× Claude Code · 1× Codex · my-app". */
export function templateSummary(t: Template): string {
  const parts: string[] = [];
  for (const p of CLI_PRESETS) {
    const n = t.counts[p.id] ?? 0;
    if (n > 0) parts.push(`${n}× ${p.label}`);
  }
  const custom = (t.custom ?? "").trim();
  if (custom && t.customCount > 0) parts.push(`${t.customCount}× ${custom}`);
  if (t.dir) parts.push(basename(t.dir) || t.dir);
  return parts.join(" · ");
}

// (The standalone Templates modal was retired — presets in the workspace
// wizard are the one place to save, launch, and delete crew configurations.)

/** Wire the spawn modal's controls + build the crew grid. Call once at startup. */
export function initSpawnModal(): void {
  buildCrewGrid();

  mConductor?.addEventListener("change", () => renderCrew());

  mCustom.addEventListener("input", () => {
    crew.custom = mCustom.value;
    renderCrew();
  });
  document.querySelector("[data-custom-stepper] [data-dec]")?.addEventListener("click", () => {
    crew.customCount = Math.max(0, crew.customCount - 1);
    renderCrew();
  });
  document.querySelector("[data-custom-stepper] [data-inc]")?.addEventListener("click", () => {
    crew.customCount = Math.min(32, crew.customCount + 1);
    renderCrew();
  });

  document.getElementById("mBrowse")?.addEventListener("click", async () => {
    const picked = await pickFolder(mDir.value || undefined);
    if (picked) {
      mDir.value = picked;
      mDir.focus();
    }
  });

  document.getElementById("mSpawn")?.addEventListener("click", () => void spawnFromModal());
  document.getElementById("mCancel")?.addEventListener("click", closeModal);
  document.getElementById("mClose")?.addEventListener("click", closeModal);
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) closeModal();
  });

  document.getElementById("mSaveTpl")?.addEventListener("click", async () => {
    const dir = mDir.value.trim();
    crew.custom = mCustom.value;
    const skipPerms = mSkipPerms.checked;
    if (expandCrew(crew).length === 0) return;
    const defName = (dir ? basename(dir) : "") || "Crew preset";
    const { ok, value } = await onConfirmModal({
      title: "Save preset",
      message: "Name this crew preset — it shows up under PRESETS in the workspace wizard.",
      okLabel: "Save",
      input: { placeholder: "Preset name", value: defName },
    });
    if (!ok) return;
    const name = value.trim() || defName;
    const tpl: Template = {
      id: "tpl-" + Math.random().toString(36).slice(2, 9),
      name,
      counts: { ...crew.counts },
      custom: crew.custom,
      customCount: crew.customCount,
      dir,
      skipPerms,
    };
    saveTemplates([...loadTemplates(), tpl]);
  });
}
