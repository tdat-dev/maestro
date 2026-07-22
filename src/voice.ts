// Push-to-talk voice input for the broadcast command bar. Fully self-contained
// via the DOM + the (still non-standard) Web Speech API: feature-detects
// support, and when present injects a mic button + its styles into #bcast on
// init. On a transcript it writes straight into #bcastInput and fires a
// synthetic "input" event, so the existing broadcast/@mention logic in
// broadcast.ts reacts exactly as if the user had typed — voice never sends on
// its own, the user still reviews and presses Enter. When speech ends it also
// splits the transcript into per-agent tasks (by detecting the active
// workspace's agent names) and offers Dispatch, which writes each task into its
// agent's PTY. Split out of main.ts; imports only leaf modules (no cycle).

import { activeWs } from "./appstate";
import { sendInput } from "./ipc";

// Minimal shape of SpeechRecognition — enough surface for push-to-talk. Kept
// local (not global) and suffixed "Like" so it can't collide with a lib.dom
// declaration; the browser's real object only needs to satisfy this shape.
interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike extends Event {
  readonly results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: Event) => void) | null;
}
interface SpeechRecognitionCtorLike {
  new (): SpeechRecognitionLike;
}

// Feature-detect once. Chrome/Edge (incl. the WebView2 shell Maestro ships
// in) expose the vendor-prefixed webkit* form; a few builds expose neither,
// which is the graceful-degrade path this module is built around.
const SR = ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) as
  | SpeechRecognitionCtorLike
  | undefined;

const MIC_ICON =
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>` +
  `<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>` +
  `<line x1="12" y1="19" x2="12" y2="23"/>` +
  `<line x1="8" y1="23" x2="16" y2="23"/>` +
  `</svg>`;

// Matches the bar's existing icon-button look (see .bcast-target-btn /
// .bcast-send in styles/broadcast.css); .listening gets a red-tinted pulse
// instead of the accent green, since green already means "broadcast live".
const MIC_STYLE = `
.bcast-mic{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
  border-radius:8px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);
  color:var(--muted);cursor:pointer;transition:all .2s ease}
.bcast-mic:hover{background:rgba(255,255,255,0.1);color:var(--text);border-color:rgba(255,255,255,0.15)}
.bcast-mic.listening{color:#ff6b6b;border-color:rgba(255,107,107,0.4);background:rgba(255,107,107,0.12);
  animation:bcastMicPulse 1.4s ease-in-out infinite}
@keyframes bcastMicPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,107,107,0.35)}50%{box-shadow:0 0 0 6px rgba(255,107,107,0)}}
`;

// Voice → dispatch panel — ported from the approved mockup's .voice component
// (orb + rings + wave, live transcript, per-agent task list, Dispatch/Cancel).
const VOICE_PANEL_STYLE = `
.voice{position:absolute;left:50%;bottom:calc(100% + 12px);transform:translateX(-50%);width:min(460px,84vw);
  background:var(--surface-1);border:1px solid var(--line-strong);border-radius:16px;padding:15px 16px;
  box-shadow:0 30px 70px -22px rgba(0,0,0,.9);display:none;z-index:230}
.voice.on{display:flex;gap:14px;align-items:flex-start}
.v-orb{position:relative;width:44px;height:44px;flex:none;display:grid;place-items:center}
.v-ring{position:absolute;inset:3px;border-radius:50%;border:2px solid #27b9a3;opacity:0}
.voice.listening .v-ring{animation:vring 1.8s ease-out infinite}
.voice.listening .v-ring:nth-child(2){animation-delay:.9s}
.v-wave{display:flex;align-items:center;gap:2px;height:22px}
.v-wave i{width:2px;height:7px;border-radius:2px;background:var(--accent);transform-origin:center}
.voice.listening .v-wave i{animation:vbar 1s ease-in-out infinite}
.v-wave i:nth-child(2){animation-delay:-.2s}.v-wave i:nth-child(3){animation-delay:-.4s}
.v-wave i:nth-child(4){animation-delay:-.6s}.v-wave i:nth-child(5){animation-delay:-.8s}
.v-body{flex:1;min-width:0}
.v-state{font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;color:#27b9a3;font-weight:700;margin-bottom:5px}
.v-text{font-family:var(--mono);font-size:13.5px;color:var(--text);line-height:1.5;min-height:18px;white-space:pre-wrap;word-break:break-word}
.v-tasks{display:flex;flex-direction:column;gap:7px;margin-top:11px}
.v-task{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text)}
.v-task .d{width:18px;height:18px;border-radius:6px;display:grid;place-items:center;font-size:9px;font-weight:800;color:#0a0d07;flex:none;background:var(--muted)}
.v-task b{color:var(--text)}
.v-empty{font-size:12px;color:var(--muted-2);margin-top:9px}
.v-actions{display:flex;flex-direction:column;gap:7px;flex:none}
.v-go{padding:8px 16px;border-radius:9px;font-weight:700;font-size:12px;color:var(--accent-ink);background:var(--accent);border:0;cursor:pointer}
.v-go:hover{filter:brightness(1.06)}
.v-go:disabled{opacity:.4;filter:grayscale(.35);cursor:default}
.v-cancel{padding:7px 16px;border-radius:9px;font-size:12px;color:var(--muted);background:none;border:1px solid var(--line-strong);cursor:pointer}
.v-cancel:hover{color:var(--text)}
@keyframes vring{0%{transform:scale(.55);opacity:.6}100%{transform:scale(1.5);opacity:0}}
@keyframes vbar{0%,100%{transform:scaleY(.4)}50%{transform:scaleY(1.7)}}
@media (prefers-reduced-motion:reduce){.voice.listening .v-ring,.voice.listening .v-wave i{animation:none}}
`;

const VOICE_PANEL_HTML =
  `<div class="v-orb"><span class="v-ring"></span><span class="v-ring"></span>` +
  `<span class="v-wave"><i></i><i></i><i></i><i></i><i></i></span></div>` +
  `<div class="v-body"><div class="v-state" id="vState">Listening…</div>` +
  `<div class="v-text" id="vText"></div><div class="v-tasks" id="vTasks"></div></div>` +
  `<div class="v-actions" id="vActions" hidden>` +
  `<button class="v-go" id="vGo" type="button">Dispatch</button>` +
  `<button class="v-cancel" id="vCancel" type="button">Cancel</button></div>`;

let recognition: SpeechRecognitionLike | null = null;
let listening = false;
let micBtn: HTMLButtonElement | null = null;
let panel: HTMLElement | null = null;
let lastTranscript = "";

function injectStyleOnce(): void {
  if (document.getElementById("voiceStyle")) return;
  const style = document.createElement("style");
  style.id = "voiceStyle";
  style.textContent = MIC_STYLE + VOICE_PANEL_STYLE;
  document.head.appendChild(style);
}

/* ---------------- transcript → per-agent tasks ---------------- */

interface VTask { name: string | null; hue: string; body: string; ids: string[] }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The active workspace's agents (name + colour + id + running). */
function currentAgents(): { name: string; hue: string; id: string; running: boolean }[] {
  const ws = activeWs;
  if (!ws) return [];
  return [...ws.panes.values()].map((p) => ({
    name: p.spec.name,
    hue: p.color || "var(--accent)",
    id: p.id,
    running: p.running,
  }));
}

/** Split a spoken sentence into per-agent tasks by detecting agent names in it.
 *  "Ana refactor the parser, Bob write the tests" → two tasks. Text before the
 *  first name (or a sentence with no names) becomes one broadcast task. */
function computeTasks(text: string): VTask[] {
  const agents = currentAgents();
  const t = text.trim();
  if (!t) return [];
  const runningIds = agents.filter((a) => a.running).map((a) => a.id);
  const hits: { idx: number; end: number; agent: (typeof agents)[number] }[] = [];
  for (const a of agents) {
    const re = new RegExp(`\\b${escapeRe(a.name)}\\b`, "gi");
    for (let m = re.exec(t); m; m = re.exec(t)) hits.push({ idx: m.index, end: m.index + m[0].length, agent: a });
  }
  hits.sort((x, y) => x.idx - y.idx);
  if (!hits.length) return [{ name: null, hue: "var(--accent)", body: t, ids: runningIds }];

  const tasks: VTask[] = [];
  const pre = t.slice(0, hits[0].idx).trim();
  if (pre) tasks.push({ name: null, hue: "var(--accent)", body: pre, ids: runningIds });
  for (let i = 0; i < hits.length; i++) {
    const body = t.slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].idx : undefined)
      .trim()
      .replace(/^[,:;.\-–]\s*/, "");
    if (!body) continue; // a name with nothing after it isn't a task
    tasks.push({ name: hits[i].agent.name, hue: hits[i].agent.hue, body, ids: hits[i].agent.running ? [hits[i].agent.id] : [] });
  }
  return tasks;
}

function setListening(on: boolean): void {
  listening = on;
  micBtn?.classList.toggle("listening", on);
  panel?.classList.toggle("listening", on);
}

/* ---------------- voice panel ---------------- */

const initials = (name: string) => name.trim().charAt(0).toUpperCase() || "◎";

function showPanel(): void {
  if (!panel) return;
  lastTranscript = "";
  const state = panel.querySelector<HTMLElement>("#vState");
  const text = panel.querySelector<HTMLElement>("#vText");
  const tasks = panel.querySelector<HTMLElement>("#vTasks");
  const actions = panel.querySelector<HTMLElement>("#vActions");
  if (state) state.textContent = "Listening…";
  if (text) text.textContent = "";
  if (tasks) tasks.replaceChildren();
  if (actions) actions.hidden = true;
  panel.classList.add("on");
}

function hidePanel(): void {
  panel?.classList.remove("on", "listening");
}

/** Speech ended: turn the transcript into per-agent tasks and reveal Dispatch. */
function reviewTasks(): void {
  if (!panel) return;
  const state = panel.querySelector<HTMLElement>("#vState");
  const tasksEl = panel.querySelector<HTMLElement>("#vTasks");
  const actions = panel.querySelector<HTMLElement>("#vActions");
  const go = panel.querySelector<HTMLButtonElement>("#vGo");
  const tasks = computeTasks(lastTranscript);
  if (!tasks.length) return hidePanel();
  if (state) state.textContent = tasks.length > 1 ? `${tasks.length} tasks · review` : "Review · dispatch";
  if (tasksEl) {
    tasksEl.replaceChildren();
    for (const t of tasks) {
      const row = document.createElement("div");
      row.className = "v-task";
      const label = t.name ?? "All";
      row.innerHTML =
        `<span class="d" style="background:${t.hue}">${escapeHtml(t.name ? initials(t.name) : "∀")}</span>` +
        `<span><b>${escapeHtml(label)}</b> ${escapeHtml(t.body)}</span>`;
      tasksEl.appendChild(row);
    }
  }
  const deliverable = tasks.some((t) => t.ids.length);
  if (actions) actions.hidden = false;
  if (go) go.disabled = !deliverable;
  panel.dataset.tasks = JSON.stringify(tasks);
}

/** Deliver each reviewed task straight into its agent's PTY, then reset. */
function dispatchTasks(): void {
  const raw = panel?.dataset.tasks;
  if (raw) {
    let tasks: VTask[] = [];
    try {
      tasks = JSON.parse(raw) as VTask[];
    } catch {
      /* corrupt — nothing to dispatch */
    }
    for (const t of tasks) for (const id of t.ids) void sendInput(id, t.body + "\r").catch(() => {});
  }
  clearInput();
  hidePanel();
}

function clearInput(): void {
  const input = document.getElementById("bcastInput") as HTMLInputElement | null;
  if (!input) return;
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// Write the transcript into the command bar (nudging broadcast.ts's own "input"
// listener) AND into the voice panel's live-transcript line.
function pushTranscript(text: string): void {
  lastTranscript = text;
  const input = document.getElementById("bcastInput") as HTMLInputElement | null;
  if (input) {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const vText = panel?.querySelector<HTMLElement>("#vText");
  if (vText) vText.textContent = text;
}

function stopListening(): void {
  if (!listening) return;
  recognition?.stop(); // onend/onerror below clear state + null the instance
}

function startListening(): void {
  if (!SR || listening) return; // guard against double-start
  const rec = new SR();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = "en-US";

  rec.onresult = (ev) => {
    let transcript = "";
    for (let i = 0; i < ev.results.length; i++) transcript += ev.results[i][0].transcript;
    pushTranscript(transcript);
  };
  rec.onend = () => {
    setListening(false);
    recognition = null;
    if (lastTranscript.trim()) reviewTasks(); // speech captured → offer dispatch
    else hidePanel();
  };
  rec.onerror = () => {
    setListening(false);
    recognition = null;
    hidePanel();
  };

  recognition = rec;
  rec.start();
  setListening(true);
  showPanel();
}

function toggleListening(): void {
  if (listening) stopListening();
  else startListening();
}

/**
 * Wire the mic button + Web Speech API. Call once at startup. No-op — injects
 * nothing — when the browser/WebView has no SpeechRecognition support, so
 * unsupported builds simply show no mic button.
 */
export function initVoice(): void {
  if (!SR) return;

  const bcast = document.getElementById("bcast");
  const sendBtn = document.getElementById("bcastSend");
  if (!bcast || !sendBtn) return;

  injectStyleOnce();

  micBtn = document.createElement("button");
  micBtn.id = "bcastMic";
  micBtn.className = "bcast-mic";
  micBtn.type = "button";
  micBtn.setAttribute("aria-label", "Voice input");
  micBtn.innerHTML = MIC_ICON;
  sendBtn.before(micBtn); // sits just before Send, inside the command field

  // The voice → dispatch panel floats above the command bar.
  panel = document.createElement("div");
  panel.className = "voice";
  panel.id = "voicePanel";
  panel.innerHTML = VOICE_PANEL_HTML;
  bcast.appendChild(panel);
  panel.querySelector("#vGo")?.addEventListener("click", dispatchTasks);
  panel.querySelector("#vCancel")?.addEventListener("click", () => {
    clearInput();
    hidePanel();
  });

  micBtn.addEventListener("click", toggleListening);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (listening || panel?.classList.contains("on"))) {
      stopListening();
      hidePanel();
    }
  });
}
