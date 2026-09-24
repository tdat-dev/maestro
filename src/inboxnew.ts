// New agent (Agent Inbox): one short form instead of the crew picker. Say what
// the agent should do, pick the CLI, and how many agents take the same job
// (two or three is a race: compare their diffs, keep the best one).

import { CLI_PRESETS, type CliPreset } from "./crew";
import { topNote } from "./hint";
import { activeWs } from "./appstate";
import { loadCrew, presetAvailable, refreshCliAvailability, saveTemplate, spawnAgents } from "./spawnmodal";
import { getPref } from "./prefs";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const LAST_CLI = "maestro.inbox.lastCli";

/** The coding CLIs worth offering here (shells stay in the old crew picker). */
export function agentPresets(): CliPreset[] {
  return CLI_PRESETS.filter((p) => !p.shell);
}

/** The button's words: "Start agent", "Start 3 agents". */
export function startLabel(count: number): string {
  return count > 1 ? `Start ${count} agents` : "Start agent";
}

let el: HTMLElement | null = null;
let returnTo: HTMLElement | null = null;

/** The CLI New agent starts on: the one set in Settings, or the last one used. */
function lastCli(): string {
  const set = getPref("defaultCli");
  if (set !== "last") return set;
  try { return localStorage.getItem(LAST_CLI) || "claude"; } catch { return "claude"; }
}

export function closeNewAgent(): void {
  el?.remove();
  el = null;
  returnTo?.focus();
  returnTo = null;
}

export function openNewAgent(opts: { count?: number } = {}): void {
  const preset = Math.min(3, Math.max(1, opts.count ?? getPref("defaultCount")));
  const ws = activeWs;
  if (!ws) { topNote("Open a project first: <b>Home</b>, then pick a folder"); return; }
  el?.remove();
  returnTo = document.activeElement as HTMLElement | null;
  const presets = agentPresets();
  const chosen = presets.some((p) => p.id === lastCli()) ? lastCli() : "claude";
  el = document.createElement("div");
  el.className = "inbox-modal-back";
  el.innerHTML = `
    <form class="inbox-modal na" role="dialog" aria-modal="true" aria-labelledby="naTitle">
      <header class="im-head">
        <div><h2 id="naTitle">New agent</h2><p class="im-sub">In ${esc(ws.name)}${ws.dir ? ` · <span class="im-mono">${esc(ws.dir)}</span>` : ""}</p></div>
        <button type="button" class="im-x" data-close aria-label="Close">✕</button>
      </header>
      <label class="im-label" for="naTask">What should it do?</label>
      <textarea id="naTask" rows="4" placeholder="Fix the flaky upload test and add a regression test. Leave empty to give it a job later."></textarea>
      <fieldset class="im-field">
        <legend class="im-label">Agent</legend>
        <div class="im-choices">${presets.map((p) => {
          const missing = !presetAvailable(p.program);
          return `<label class="im-choice${missing ? " missing" : ""}" title="${missing ? `${esc(p.program)} is not installed` : esc(p.program)}">
            <input type="radio" name="naCli" value="${esc(p.id)}"${p.id === chosen ? " checked" : ""}${missing ? " disabled" : ""}><span>${esc(p.label)}</span></label>`;
        }).join("")}</div>
      </fieldset>
      <div class="im-row">
        <fieldset class="im-field">
          <legend class="im-label">How many</legend>
          <div class="im-seg">${[1, 2, 3].map((n) => `<label><input type="radio" name="naCount" value="${n}"${n === preset ? " checked" : ""}><span>${n}</span></label>`).join("")}</div>
        </fieldset>
        <p class="im-hint" data-race${preset > 1 ? "" : " hidden"}>They all get the same job. Compare their changes in Review and keep the best.</p>
      </div>
      <label class="im-check"><input type="checkbox" id="naSkip"${loadCrew().skipPerms ? " checked" : ""}> Don't ask before running commands or editing files</label>
      <footer class="im-foot">
        <button type="button" class="im-btn quiet" data-save title="Keep this setup so Settings → Sessions → Scheduled agents can start it at a set time">Save as preset</button>
        <span class="im-sp"></span>
        <button type="button" class="im-btn" data-close>Cancel</button>
        <button type="submit" class="im-btn primary" data-start title="Start (Ctrl+Enter)" aria-keyshortcuts="Control+Enter">${startLabel(preset)}</button>
      </footer>
    </form>`;
  document.body.appendChild(el);
  const form = el.querySelector("form")!;
  const task = el.querySelector<HTMLTextAreaElement>("#naTask")!;
  const start = el.querySelector<HTMLButtonElement>("[data-start]")!;
  const count = () => Number(form.querySelector<HTMLInputElement>('input[name="naCount"]:checked')?.value ?? 1);
  form.addEventListener("change", () => {
    start.textContent = startLabel(count());
    el?.querySelector<HTMLElement>("[data-race]")?.toggleAttribute("hidden", count() < 2);
  });
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t === el || t.closest("[data-close]")) { closeNewAgent(); return; }
    if (t.closest("[data-save]")) {
      const cli = form.querySelector<HTMLInputElement>('input[name="naCli"]:checked')?.value;
      if (!cli) return;
      const label = agentPresets().find((p) => p.id === cli)?.label ?? cli;
      const n = count();
      saveTemplate(`${n > 1 ? `${n}× ` : ""}${label} · ${ws.name}`, { [cli]: n }, ws.dir ?? "", el?.querySelector<HTMLInputElement>("#naSkip")?.checked ?? false);
      const b = t.closest<HTMLButtonElement>("[data-save]")!;
      b.textContent = "Saved";
      b.disabled = true;
    }
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeNewAgent(); }
    // Ctrl+Enter starts from inside the text box.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const cli = form.querySelector<HTMLInputElement>('input[name="naCli"]:checked')?.value;
    if (!cli) return;
    try { localStorage.setItem(LAST_CLI, cli); } catch { /* private window */ }
    const job = task.value.trim() || null;
    const skip = el?.querySelector<HTMLInputElement>("#naSkip")?.checked ?? false;
    const n = count();
    returnTo = null; // the new agent takes the focus, not the dock button
    closeNewAgent();
    void spawnAgents(ws, cli, n, job, skip);
  });
  task.focus();
  // Grey out CLIs that aren't installed once the probe answers.
  void refreshCliAvailability().then(() => {
    el?.querySelectorAll<HTMLInputElement>('input[name="naCli"]').forEach((input) => {
      const p = presets.find((x) => x.id === input.value);
      const missing = !!p && !presetAvailable(p.program);
      input.disabled = missing;
      input.closest(".im-choice")?.classList.toggle("missing", missing);
      if (missing && input.checked) {
        input.checked = false;
        el?.querySelector<HTMLInputElement>('input[name="naCli"]:not(:disabled)')?.click();
      }
    });
  });
}
