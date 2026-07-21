// Token usage & estimated cost modal. Reads Claude Code's own session
// transcripts via the backend and renders a per-model table. Split from
// main.ts; the active workspace + settings-close are injected.

import { claudeUsage, type ModelUsage } from "./ipc";
import { basename } from "./workspaces";
import { type Workspace } from "./panetypes";

let getWs: () => Workspace | null = () => null;
let onCloseSettings: () => void = () => {};
export function configureUsage(deps: { getActiveWs: () => Workspace | null; closeSettings: () => void }): void {
  getWs = deps.getActiveWs;
  onCloseSettings = deps.closeSettings;
}

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Approximate Claude API prices in USD per million tokens. Cache-write is the
// 5-minute ephemeral rate (1.25× input); cache-read is 0.1× input. Kept as a
// clearly-labelled estimate — matched by substring so model-id suffixes don't
// matter. Models not listed here (e.g. fable) show tokens but no cost.
interface Price { in: number; out: number; cacheWrite: number; cacheRead: number }
const MODEL_PRICES: Array<{ match: string; p: Price }> = [
  { match: "opus", p: { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { match: "sonnet", p: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { match: "haiku", p: { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
];

function priceFor(model: string): Price | null {
  const m = model.toLowerCase();
  return MODEL_PRICES.find((x) => m.includes(x.match))?.p ?? null;
}

/** Estimated USD cost for one model's usage, or null when the model isn't priced. */
function usageCost(u: ModelUsage): number | null {
  const p = priceFor(u.model);
  if (!p) return null;
  return (
    (u.input_tokens * p.in +
      u.output_tokens * p.out +
      u.cache_creation * p.cacheWrite +
      u.cache_read * p.cacheRead) /
    1e6
  );
}

function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
function fmtCost(usd: number): string {
  return usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Prettify a model id for the table (drop the vendor prefix + date suffix). */
function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{6,}$/, "");
}

const usageModal = document.getElementById("usageModal") as HTMLElement | null;

async function renderUsage(dir: string): Promise<void> {
  const wrap = document.getElementById("usageWrap");
  const empty = document.getElementById("usageEmpty");
  if (!wrap) return;
  wrap.replaceChildren();
  let rows: ModelUsage[] = [];
  try {
    rows = await claudeUsage(dir);
  } catch {
    /* leave empty */
  }
  if (empty) empty.hidden = rows.length > 0;
  if (!rows.length) return;

  let totalCost = 0;
  let anyUnpriced = false;
  const body = rows
    .map((u) => {
      const cost = usageCost(u);
      if (cost === null) anyUnpriced = true;
      else totalCost += cost;
      const cache = u.cache_creation + u.cache_read;
      return (
        `<tr><td class="um-model">${escHtml(shortModel(u.model))}</td>` +
        `<td>${u.messages}</td>` +
        `<td>${fmtTokens(u.input_tokens)}</td>` +
        `<td>${fmtTokens(u.output_tokens)}</td>` +
        `<td>${fmtTokens(cache)}</td>` +
        `<td class="um-cost">${cost === null ? "—" : fmtCost(cost)}</td></tr>`
      );
    })
    .join("");
  const table =
    `<table class="usage-tbl"><thead><tr>` +
    `<th>Model</th><th>Msgs</th><th>Input</th><th>Output</th><th>Cache</th><th>Est. cost</th>` +
    `</tr></thead><tbody>${body}</tbody>` +
    `<tfoot><tr><td colspan="5">Estimated total${anyUnpriced ? " (priced models only)" : ""}</td>` +
    `<td class="um-cost">${fmtCost(totalCost)}</td></tr></tfoot></table>`;
  wrap.innerHTML = table;
}

export function openUsage(ws: Workspace): void {
  if (!usageModal) return;
  const dir = ws.dir ?? ws.panes.values().next().value?.spec.cwd ?? null;
  const crumb = document.getElementById("usageCrumb");
  if (crumb) crumb.textContent = dir ? basename(dir) : "";
  const wrap = document.getElementById("usageWrap");
  if (wrap) wrap.replaceChildren();
  const empty = document.getElementById("usageEmpty");
  if (empty) empty.hidden = true;
  usageModal.classList.add("open");
  if (dir) void renderUsage(dir);
  else if (empty) empty.hidden = false;
}
function closeUsage(): void {
  usageModal?.classList.remove("open");
}

/** Wire the usage modal's open/close controls. Call once at startup. */
export function initUsage(): void {
  document.getElementById("setOpenUsage")?.addEventListener("click", () => {
    onCloseSettings();
    const ws = getWs();
    if (ws) openUsage(ws);
  });
  document.getElementById("usageClose")?.addEventListener("click", closeUsage);
  document.getElementById("usageCloseBtn")?.addEventListener("click", closeUsage);
  usageModal?.addEventListener("mousedown", (e) => {
    if (e.target === usageModal) closeUsage();
  });
}
