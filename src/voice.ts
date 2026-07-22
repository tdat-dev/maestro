// Push-to-talk voice input for the broadcast command bar. Fully self-contained
// via the DOM + the (still non-standard) Web Speech API: feature-detects
// support, and when present injects a mic button + its styles into #bcast on
// init. On a transcript it writes straight into #bcastInput and fires a
// synthetic "input" event, so the existing broadcast/@mention logic in
// broadcast.ts reacts exactly as if the user had typed — voice never sends on
// its own, the user still reviews and presses Enter. Split out of main.ts;
// this module owns no app state and never imports back into main (no cycle).

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

let recognition: SpeechRecognitionLike | null = null;
let listening = false;
let micBtn: HTMLButtonElement | null = null;

function injectStyleOnce(): void {
  if (document.getElementById("voiceStyle")) return;
  const style = document.createElement("style");
  style.id = "voiceStyle";
  style.textContent = MIC_STYLE;
  document.head.appendChild(style);
}

function setListening(on: boolean): void {
  listening = on;
  micBtn?.classList.toggle("listening", on);
}

// Write the transcript into the command bar and nudge broadcast.ts's own
// "input" listener (enable-send + @mention autocomplete) as if typed.
function pushTranscript(text: string): void {
  const input = document.getElementById("bcastInput") as HTMLInputElement | null;
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
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
  };
  rec.onerror = () => {
    setListening(false);
    recognition = null;
  };

  recognition = rec;
  rec.start();
  setListening(true);
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

  micBtn.addEventListener("click", toggleListening);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && listening) stopListening();
  });
}
