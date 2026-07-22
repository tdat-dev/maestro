// Inline spawn menu — the dropdown that opens above the command bar's
// "+Agent" button. Replaces the full spawn modal for that entry point: pick a
// count per CLI preset (+ a custom command row), see a running total, hit
// Spawn. Reuses spawnCrew() from spawnmodal.ts so it boots agents exactly the
// way the modal and the wizard already do — just straight into the active
// workspace. Self-contained: injects its own markup + CSS, touches no shared
// html/css files.

import { CLI_PRESETS, type CrewState, type CliPreset } from "./crew";
import { activeWs } from "./appstate";

let onSpawnCrew: (
  crewState: CrewState,
  dir: string | null,
  skipPerms: boolean,
  mode: "new" | "current",
) => Promise<void> = async () => {};
let onIsPresetAvailable: (program: string) => boolean = () => true;
let onRefreshCliAvailability: () => void = () => {};

export function configureSpawnMenu(deps: {
  spawnCrew: (
    crewState: CrewState,
    dir: string | null,
    skipPerms: boolean,
    mode: "new" | "current",
  ) => Promise<void>;
  isPresetAvailable: (program: string) => boolean;
  refreshCliAvailability: () => void;
}): void {
  onSpawnCrew = deps.spawnCrew;
  onIsPresetAvailable = deps.isPresetAvailable;
  onRefreshCliAvailability = deps.refreshCliAvailability;
}

// Per-CLI dot colour. Mirrors main.ts's CLI_COLORS (kept local — that map
// isn't exported, and this is the only other place that needs it).
const DOT_COLOR: Record<string, string> = {
  claude: "#d97757", codex: "#10a37f", gemini: "#4f8cf7", aider: "#c6f135",
  cursor: "#e8edf2", opencode: "#f0883e", qwen: "#a855f7", copilot: "#9aa4b2",
  goose: "#f6c453", shell: "#5ec2f0", cmd: "#94a3b1", custom: "#c6f135",
};

const STYLE_ID = "spawnMenuStyles";
const CSS = `
.sm-anchor{position:relative;flex:none}
.spawn-menu{position:absolute;right:0;bottom:calc(100% + 8px);width:256px;background:var(--surface-1);
  border:1px solid var(--line-2);border-radius:13px;padding:8px;box-shadow:0 24px 50px -18px rgba(0,0,0,.85);
  display:none;z-index:210}
.spawn-menu.on{display:block;animation:smPop .14s ease}
.sm-h{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);padding:4px 6px 8px}
.sm-crew{display:flex;flex-direction:column;gap:1px;max-height:280px;overflow-y:auto}
.sm-row{display:flex;align-items:center;gap:10px;padding:5px 7px;border-radius:8px}
.sm-row:hover{background:var(--surface-2)}
.sm-row.missing{opacity:.45}
.sm-row .d{width:9px;height:9px;border-radius:50%;flex:none}
.sm-name{font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-step{margin-left:auto;display:flex;align-items:center;gap:1px;background:var(--surface-2);
  border:1px solid var(--line-strong);border-radius:8px;padding:2px;flex:none}
.sm-step button{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;color:var(--muted);
  font-size:16px;line-height:1;background:none;border:0}
.sm-step button:hover{background:rgba(255,255,255,.08);color:var(--text)}
.sm-step button:disabled{opacity:.35;cursor:default}
.sm-step button:disabled:hover{background:none}
.sm-step .n{min-width:20px;text-align:center;font-family:var(--mono);font-size:12px;color:var(--text);
  font-variant-numeric:tabular-nums}
.sm-custom{display:flex;align-items:center;gap:8px;margin-top:6px;padding-top:8px;border-top:1px solid var(--line)}
.sm-cin{flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--line-strong);border-radius:8px;
  padding:7px 9px;color:var(--text);font-family:var(--mono);font-size:11.5px;outline:none}
.sm-cin:focus{border-color:color-mix(in oklab,var(--teal) 50%,var(--line-2))}
.sm-cin::placeholder{color:var(--muted)}
.sm-foot{display:flex;align-items:center;justify-content:space-between;margin-top:8px;padding:0 4px}
.sm-total{font-size:12px;color:var(--muted)}
.sm-total b{color:var(--text);font-variant-numeric:tabular-nums}
.sm-spawn{padding:8px 16px;border-radius:9px;font-weight:700;font-size:12.5px;color:#0a0d07;
  background:var(--grad);border:0}
.sm-spawn:disabled{opacity:.4;filter:grayscale(.35);cursor:default}
.sm-spawn:not(:disabled):hover{filter:brightness(1.06)}
@keyframes smPop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
`;

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// Per-preset spawn count for this open menu; zeroed out after every Spawn.
const counts: Record<string, number> = {};
let customCount = 0;

let menuEl: HTMLElement;
let crewEl: HTMLElement;
let customInputEl: HTMLInputElement;
let customStepEl: HTMLElement;
let totalEl: HTMLElement;
let spawnBtnEl: HTMLButtonElement;

function total(): number {
  return Object.values(counts).reduce((s, n) => s + n, 0) + customCount;
}

function renderCounts(): void {
  for (const p of CLI_PRESETS) {
    const n = crewEl.querySelector<HTMLElement>(`.sm-step[data-cli="${p.id}"] .n`);
    if (n) n.textContent = String(counts[p.id] ?? 0);
  }
  customStepEl.querySelector<HTMLElement>(".n")!.textContent = String(customCount);
  const t = total();
  totalEl.textContent = String(t);
  spawnBtnEl.disabled = t === 0;
}

function buildRow(p: CliPreset): HTMLElement {
  const row = document.createElement("div");
  row.className = "sm-row";
  row.innerHTML = `<span class="d" style="background:${DOT_COLOR[p.badge] ?? "#8b95a3"}"></span>
    <span class="sm-name">${p.label}</span>
    <div class="sm-step" data-cli="${p.id}">
      <button type="button" data-dec aria-label="One fewer">−</button>
      <span class="n">0</span>
      <button type="button" data-inc aria-label="One more">+</button>
    </div>`;
  row.querySelector<HTMLButtonElement>("[data-dec]")!.addEventListener("click", () => {
    counts[p.id] = Math.max(0, (counts[p.id] ?? 0) - 1);
    renderCounts();
  });
  row.querySelector<HTMLButtonElement>("[data-inc]")!.addEventListener("click", () => {
    if (!onIsPresetAvailable(p.program)) return; // uninstalled CLI — can't add
    counts[p.id] = Math.min(32, (counts[p.id] ?? 0) + 1);
    renderCounts();
  });
  return row;
}

/** Grey out + disable "+" for any preset whose binary isn't on PATH. */
function refreshAvailability(): void {
  crewEl.querySelectorAll<HTMLElement>(".sm-row").forEach((row) => {
    const cli = row.querySelector<HTMLElement>(".sm-step")?.dataset.cli;
    const p = CLI_PRESETS.find((x) => x.id === cli);
    const missing = p ? !onIsPresetAvailable(p.program) : false;
    row.classList.toggle("missing", missing);
    row.querySelector<HTMLButtonElement>("[data-inc]")!.disabled = missing;
    if (missing && p) row.title = `${p.program} not found on PATH`;
    else row.removeAttribute("title");
  });
}

function resetMenu(): void {
  for (const key of Object.keys(counts)) counts[key] = 0;
  customCount = 0;
  customInputEl.value = "";
  renderCounts();
}

function closeMenu(): void {
  menuEl.classList.remove("on");
}

async function doSpawn(): Promise<void> {
  if (total() === 0) return;
  const crewState: CrewState = { counts: { ...counts }, custom: customInputEl.value, customCount };
  closeMenu();
  resetMenu();
  await onSpawnCrew(crewState, activeWs?.dir ?? null, false, "current");
}

/** Build `#spawnMenu` and mount it beside `#cbAddAgent` (wrapping the button in
 *  a positioning anchor so the dropdown floats above it), then wire the click
 *  that toggles it. Call once at startup, after configureSpawnMenu. */
export function initSpawnMenu(): void {
  injectStyles();

  const addBtn = document.getElementById("cbAddAgent");
  if (!addBtn) return;

  const anchor = document.createElement("div");
  anchor.className = "sm-anchor";
  addBtn.replaceWith(anchor);
  anchor.appendChild(addBtn);

  menuEl = document.createElement("div");
  menuEl.className = "spawn-menu";
  menuEl.id = "spawnMenu";
  menuEl.innerHTML = `<div class="sm-h">Spawn agents · pick how many</div>
    <div class="sm-crew"></div>
    <div class="sm-custom">
      <input class="sm-cin" spellcheck="false" autocomplete="off" placeholder="Custom · e.g. ollama run llama3">
      <div class="sm-step" data-cli="__custom">
        <button type="button" data-dec aria-label="One fewer">−</button>
        <span class="n">0</span>
        <button type="button" data-inc aria-label="One more">+</button>
      </div>
    </div>
    <div class="sm-foot"><span class="sm-total">Total <b>0</b></span><button class="sm-spawn" type="button" disabled>Spawn</button></div>`;
  anchor.appendChild(menuEl);

  crewEl = menuEl.querySelector(".sm-crew") as HTMLElement;
  for (const p of CLI_PRESETS) crewEl.appendChild(buildRow(p));

  customInputEl = menuEl.querySelector(".sm-cin") as HTMLInputElement;
  customStepEl = menuEl.querySelector('.sm-step[data-cli="__custom"]') as HTMLElement;
  totalEl = menuEl.querySelector(".sm-total b") as HTMLElement;
  spawnBtnEl = menuEl.querySelector(".sm-spawn") as HTMLButtonElement;

  customStepEl.querySelector<HTMLButtonElement>("[data-dec]")!.addEventListener("click", () => {
    customCount = Math.max(0, customCount - 1);
    renderCounts();
  });
  customStepEl.querySelector<HTMLButtonElement>("[data-inc]")!.addEventListener("click", () => {
    customCount = Math.min(32, customCount + 1);
    renderCounts();
  });

  spawnBtnEl.addEventListener("click", () => void doSpawn());

  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = !menuEl.classList.contains("on");
    menuEl.classList.toggle("on", opening);
    if (opening) {
      onRefreshCliAvailability();
      refreshAvailability();
    }
  });
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Node) || !anchor.contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuEl.classList.contains("on")) closeMenu();
  });
}
