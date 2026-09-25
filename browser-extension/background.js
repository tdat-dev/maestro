/* Maestro for Chrome — service worker.
 *
 * Chrome starts Maestro's native host (maestro.exe) when we connect to
 * "com.maestro.browser"; the host relays to the Maestro app, which routes
 * calls from its agents here. Each call runs one browser action and answers
 * with an MCP-shaped result ({ content: [...] }).
 *
 * Every agent works in its own tab group, titled with its name. Input,
 * screenshots and page JavaScript go through chrome.debugger (the Chrome
 * DevTools Protocol), so clicks and keys are real browser input. */

import { snapshotPage, locateRef, fillRef, findInPage, pageText, labelAt, blockerOf, markForUpload, unmarkUpload } from "./page.js";
import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.esm.js";
import { cursorAct } from "./cursor.js";

const HOST = "com.maestro.browser";
const COLORS = ["blue", "purple", "green", "orange", "pink", "cyan", "red", "yellow"];
/** Chrome's tab group colours, so the cursor matches the agent's group. */
const HEX = { grey: "#5f6368", blue: "#1a73e8", red: "#d93025", yellow: "#e8a500", green: "#1e8e3e", pink: "#d01884", purple: "#9334e6", cyan: "#007b83", orange: "#e8710a" };
const MAX_CONSOLE = 300;
const MAX_NETWORK = 300;
/** Clicks that are hard to take back: sending, posting, paying, deleting.
 *  When Maestro asks for it (args._ask), such a click waits for the user's OK. */
const RISKY = /^(gửi|gửi ngay|send|send now|đăng|đăng bài|đăng ngay|post|publish|share|chia sẻ|thanh toán|pay|pay now|mua|mua ngay|buy|buy now|đặt hàng|place order|checkout|xác nhận thanh toán|confirm payment|chuyển tiền|transfer|xóa|xoá|delete|remove)$/i;
const BLOCKER_NOTE = {
  login: "This page asks for a login. Stop here and ask the user to sign in in this tab themselves; carry on once they say it is done. Never type their password.",
  captcha: "This page shows a CAPTCHA. Stop here and ask the user to solve it in this tab; carry on once they say it is done.",
};

let port = null;
let status = { state: "connecting", detail: "" };
let retry = null;

// ---------------------------------------------------------------- connection

function connect() {
  if (port) return;
  clearTimeout(retry);
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    setStatus("no-host", String(e?.message ?? e));
    return later();
  }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    const why = chrome.runtime.lastError?.message ?? "";
    port = null;
    setStatus(/not found/i.test(why) ? "no-host" : "offline", why);
    later();
  });
  setStatus("connecting", "");
  void hello();
}

function later() {
  clearTimeout(retry);
  retry = setTimeout(connect, 3000);
  // The worker may be stopped before the timer fires; an alarm wakes it.
  chrome.alarms.create("reconnect", { delayInMinutes: 0.5 });
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === "reconnect") connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

function setStatus(state, detail) {
  status = { state, detail };
  const badge = state === "ready" ? "" : state === "hub-down" ? "off" : "!";
  chrome.action.setBadgeText({ text: badge }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#6b6b76" }).catch(() => {});
}

function send(msg) {
  try { port?.postMessage(msg); } catch { /* the disconnect handler reconnects */ }
}

async function hello() {
  let email = "";
  try { email = (await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" })).email ?? ""; } catch {}
  const brands = (navigator.userAgentData?.brands ?? []).map((b) => b.brand);
  const browser =
    brands.find((b) => /Edge|Brave|Opera|Vivaldi/.test(b)) ??
    brands.find((b) => /Google Chrome/.test(b)) ?? "Chromium";
  send({ type: "browser_info", email, browser, version: chrome.runtime.getManifest().version });
}

async function onMessage(msg) {
  if (msg?.type === "hub_up") return setStatus("ready", "");
  if (msg?.type === "hub_down") return setStatus("hub-down", msg.detail ?? "");
  if (msg?.type !== "call") return;
  setStatus("ready", "");
  const { id, agent, tool, args = {} } = msg;
  try {
    const result = await run(agent || "Agent", tool, args);
    send({ type: "result", id, result });
  } catch (e) {
    send({ type: "error", id, error: String(e?.message ?? e) });
  }
}

// The popup asks how things stand.
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m?.type === "stop_agent" && m.agent) {
    // Stop, pressed on the pill over the page: Maestro refuses the agent's
    // browser calls until you let it go on there.
    send({ type: "pause", agent: m.agent });
    return;
  }
  if (m?.type !== "status") return;
  (async () => {
    const groups = await chrome.tabGroups.query({});
    const own = await agentGroups();
    const agents = [];
    for (const [name, gid] of Object.entries(own)) {
      if (!groups.some((g) => g.id === gid)) continue;
      agents.push({ name, tabs: (await chrome.tabs.query({ groupId: gid })).length });
    }
    let email = "";
    try { email = (await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" })).email ?? ""; } catch {}
    reply({ ...status, email, agents });
  })();
  return true;
});

// ---------------------------------------------------------------- tab groups

async function agentGroups() {
  return (await chrome.storage.session.get("groups")).groups ?? {};
}

async function groupOf(agent) {
  const all = await agentGroups();
  const gid = all[agent];
  if (gid != null) {
    try { await chrome.tabGroups.get(gid); return gid; } catch {}
  }
  // The extension was updated or restarted and forgot its map: the agent's
  // group is still there, titled with its name. Take it back instead of
  // making the agent open a new tab.
  const found = (await chrome.tabGroups.query({ title: agent }))[0];
  if (!found) return null;
  await chrome.storage.session.set({ groups: { ...all, [agent]: found.id } });
  return found.id;
}

function colorFor(agent) {
  let h = 0;
  for (const c of agent) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

async function agentTabs(agent) {
  const gid = await groupOf(agent);
  return gid == null ? [] : chrome.tabs.query({ groupId: gid });
}

async function intoGroup(agent, tabId) {
  let gid = await groupOf(agent);
  if (gid == null) {
    gid = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(gid, { title: agent, color: colorFor(agent) });
    const all = await agentGroups();
    await chrome.storage.session.set({ groups: { ...all, [agent]: gid } });
  } else {
    await chrome.tabs.group({ groupId: gid, tabIds: [tabId] });
  }
}

/** The tab an agent means: the one it named (must be in its group), or its
 *  most recent one. */
async function tabFor(agent, tabId) {
  const mine = await agentTabs(agent);
  if (tabId != null) {
    const t = mine.find((x) => x.id === tabId);
    if (!t) throw new Error(`Tab ${tabId} is not one of ${agent}'s tabs. Use browser_tabs to see them, or browser_tab_adopt to take over a tab you were given.`);
    return t;
  }
  if (!mine.length) throw new Error(`${agent} has no tab yet. Open a page with browser_navigate.`);
  return mine.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

/** A minimised window has no page size, so clicks land nowhere and nothing
 *  paints. Bring the agent's window back before it reads or acts. */
async function shown(t) {
  const w = await chrome.windows.get(t.windowId).catch(() => null);
  if (w?.state === "minimized") {
    await chrome.windows.update(w.id, { state: "normal" });
    await sleep(300);
  }
  return t;
}

const brief = (t) => ({ tabId: t.id, title: t.title ?? "", url: t.url ?? t.pendingUrl ?? "", active: t.active });

// ---------------------------------------------------------------- debugger

const attached = new Set();
const consoleLog = new Map(); // tabId -> [{level, text, at}]
const networkLog = new Map(); // tabId -> Map(requestId -> entry)
const dialogs = new Map(); // tabId -> {type, message}

async function dbg(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    const m = String(e?.message ?? e);
    if (!/already attached/i.test(m)) throw new Error(`Can't control this tab: ${m}. Chrome doesn't let extensions drive chrome:// pages, the Web Store, or other extensions' pages.`);
  }
  attached.add(tabId);
  await Promise.all(["Page.enable", "Runtime.enable", "Network.enable"].map((m) => cdp(tabId, m).catch(() => {})));
}

const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));
chrome.tabs.onRemoved.addListener((tabId) => {
  lastPos.delete(tabId);
  attached.delete(tabId);
  consoleLog.delete(tabId);
  networkLog.delete(tabId);
  dialogs.delete(tabId);
});

chrome.debugger.onEvent.addListener((src, method, p) => {
  const tabId = src.tabId;
  if (method === "Runtime.consoleAPICalled") {
    const text = p.args.map((a) => a.value ?? a.description ?? a.unserializableValue ?? "").join(" ");
    push(consoleLog, tabId, { level: p.type, text, at: Date.now() }, MAX_CONSOLE);
  } else if (method === "Runtime.exceptionThrown") {
    const d = p.exceptionDetails;
    push(consoleLog, tabId, { level: "exception", text: d.exception?.description ?? d.text, at: Date.now() }, MAX_CONSOLE);
  } else if (method === "Network.requestWillBeSent") {
    const m = networkLog.get(tabId) ?? new Map();
    m.set(p.requestId, { method: p.request.method, url: p.request.url, type: p.type, status: 0 });
    if (m.size > MAX_NETWORK) m.delete(m.keys().next().value);
    networkLog.set(tabId, m);
  } else if (method === "Network.responseReceived") {
    const e = networkLog.get(tabId)?.get(p.requestId);
    if (e) { e.status = p.response.status; e.mime = p.response.mimeType; }
  } else if (method === "Network.loadingFailed") {
    const e = networkLog.get(tabId)?.get(p.requestId);
    if (e) e.error = p.errorText;
  } else if (method === "Page.javascriptDialogOpening") {
    dialogs.set(tabId, { type: p.type, message: p.message });
  } else if (method === "Page.javascriptDialogClosed") {
    dialogs.delete(tabId);
  }
});

function push(map, key, item, max) {
  const list = map.get(key) ?? [];
  list.push(item);
  if (list.length > max) list.shift();
  map.set(key, list);
}

function guardDialog(tabId) {
  const d = dialogs.get(tabId);
  if (d) throw new Error(`A ${d.type} dialog is open on this tab: "${d.message}". Answer it with browser_dialog first.`);
}

// ---------------------------------------------------------------- helpers

const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inPage(tabId, func, args) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  if (r?.result?.error) throw new Error(r.result.error);
  return r?.result;
}

function waitLoaded(tabId, ms = 20000) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); chrome.tabs.onUpdated.removeListener(on); resolve(); };
    const on = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const t = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === "complete") done(); }).catch(done);
  });
}

function withScheme(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (/^(localhost|127\.|\[::1\])/i.test(url)) return "http://" + url;
  return "https://" + url;
}

/** A picture of what the tab shows, at most `maxW` wide, as base64 JPEG.
 *
 * It copies the frame Chrome already painted (captureVisibleTab), so the
 * page is never touched: a CDP screenshot with a clip makes Chrome re-lay the
 * view out, and the page visibly flashed on every frame of Maestro's live
 * view. The CDP path is only the fallback, for a tab that isn't the one
 * showing in its window, and it runs without a clip. */
async function grab(tab, maxW, quality) {
  let blob = null;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (tab.active && win && win.state !== "minimized") {
    try {
      const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality });
      blob = await (await fetch(url)).blob();
    } catch { /* over Chrome's two-a-second limit, or a page it won't copy */ }
  }
  if (!blob) {
    await dbg(tab.id);
    const shot = await Promise.race([
      cdp(tab.id, "Page.captureScreenshot", { format: "jpeg", quality, optimizeForSpeed: true }),
      // A tab behind another one has to be painted first: 1–3 s.
      sleep(3500).then(() => null),
    ]);
    if (!shot) throw new Error("The tab isn't showing right now.");
    blob = await (await fetch(`data:image/jpeg;base64,${shot.data}`)).blob();
  }
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxW / bmp.width);
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  let out = blob;
  if (scale < 1) {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, 0, 0, w, h);
    out = await c.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
  }
  bmp.close();
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), width: w, height: h };
}

/** The agent's screenshot: in page (CSS) pixels, so its coordinates are the
 *  ones clicks use. */
async function screenshot(tab) {
  const t = await chrome.tabs.get(tab.id);
  const img = await grab(t, t.width || 1600, 70);
  return {
    content: [
      { type: "image", data: img.data, mimeType: "image/jpeg" },
      { type: "text", text: `Screenshot ${img.width}x${img.height}; click coordinates use these pixels.` },
    ],
  };
}

const KEYS = {
  enter: ["Enter", 13], tab: ["Tab", 9], escape: ["Escape", 27], esc: ["Escape", 27], backspace: ["Backspace", 8],
  delete: ["Delete", 46], space: [" ", 32], arrowup: ["ArrowUp", 38], arrowdown: ["ArrowDown", 40],
  arrowleft: ["ArrowLeft", 37], arrowright: ["ArrowRight", 39], up: ["ArrowUp", 38], down: ["ArrowDown", 40],
  left: ["ArrowLeft", 37], right: ["ArrowRight", 39], home: ["Home", 36], end: ["End", 35],
  pageup: ["PageUp", 33], pagedown: ["PageDown", 34],
};
const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

async function pressKeys(tabId, combo) {
  for (const chord of combo.trim().split(/\s+/)) {
    const parts = chord.split("+");
    const keyName = parts.pop();
    let modifiers = 0;
    for (const p of parts) modifiers |= MODS[p.toLowerCase()] ?? 0;
    const known = KEYS[keyName.toLowerCase()];
    const key = known ? known[0] : keyName.length === 1 ? keyName : keyName;
    const code = known ? known[1] : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
    const base = { key, windowsVirtualKeyCode: code, modifiers, code: key.length === 1 ? `Key${key.toUpperCase()}` : key };
    const textish = key.length === 1 && !(modifiers & (1 | 2 | 4));
    await cdp(tabId, "Input.dispatchKeyEvent", { type: textish ? "keyDown" : "rawKeyDown", ...base, ...(textish ? { text: key } : {}) });
    if (key === "Enter" && !modifiers) await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}

async function mouse(tabId, x, y, { button = "left", clicks = 1 } = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let i = 1; i <= clicks; i++) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i });
  }
}

async function point(tabId, args) {
  if (args.ref) return inPage(tabId, locateRef, [args.ref]);
  if (Array.isArray(args.coordinate) && args.coordinate.length === 2) return { x: args.coordinate[0], y: args.coordinate[1] };
  throw new Error("Give a ref (from browser_read_page) or a coordinate [x, y] (from a screenshot).");
}

// ---------------------------------------------------------------- GIF recording

/** An agent's recording: frames copied from its tab twice a second, only
 *  while it records, only while the tab is showing (the copy is free then). */
const recordings = new Map(); // agent -> { tabId, frames: [{ data, at }], timer, busy }
const GIF_FPS_MS = 500;
const GIF_MAX_FRAMES = 240; // two minutes
const GIF_WIDTH = 640;

function startRecording(agent, tabId) {
  stopRecording(agent);
  const rec = { tabId, frames: [], busy: false, started: Date.now() };
  rec.timer = setInterval(async () => {
    if (rec.busy) return;
    if (rec.frames.length >= GIF_MAX_FRAMES) return stopRecording(agent, true);
    rec.busy = true;
    try {
      const tab = await chrome.tabs.get(rec.tabId);
      if (tab.active) {
        const img = await grab(tab, GIF_WIDTH, 70);
        const last = rec.frames[rec.frames.length - 1];
        // A still page adds time to the last frame instead of another frame.
        if (last && last.data === img.data) last.until = Date.now();
        else rec.frames.push({ data: img.data, at: Date.now(), until: Date.now() });
      }
    } catch {} finally { rec.busy = false; }
  }, GIF_FPS_MS);
  recordings.set(agent, rec);
  return rec;
}

function stopRecording(agent, keep = false) {
  const rec = recordings.get(agent);
  if (!rec) return null;
  clearInterval(rec.timer);
  if (!keep) recordings.delete(agent);
  return rec;
}

/** Encode the frames as an animated GIF (base64), one frame at a time so
 *  memory stays small. */
async function encodeGif(frames) {
  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${f.data}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    bmp.close();
    const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    const next = frames[i + 1]?.at ?? f.until + GIF_FPS_MS;
    gif.writeFrame(index, width, height, { palette, delay: Math.max(GIF_FPS_MS, next - f.at) });
  }
  gif.finish();
  const bytes = gif.bytes();
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Where each tab's cursor last was, so a new page starts it there. */
const lastPos = new Map();

/** Drive the agent's cursor in the page (see cursor.js). Never fails a tool:
 *  a page that can't be drawn on (chrome://, the Web Store) just has none. */
async function cursor(tabId, agent, op, extra = {}) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: cursorAct,
      args: [op, { ...extra, name: agent, color: HEX[colorFor(agent)], from: lastPos.get(tabId) }],
    });
    if (Array.isArray(r?.result)) lastPos.set(tabId, r.result);
  } catch {}
}

/** "ctrl+a" → "Ctrl+A", "Enter" → "Enter", for the chip beside the cursor. */
const prettyKeys = (combo) =>
  combo.trim().split(/\s+/).map((c) => c.split("+").map((k) => (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join("+")).join("  ");

/** Add a note (and a flag Maestro reads) when the page wants a person. */
async function withBlocker(tabId, result) {
  let kind = "";
  try { kind = (await inPage(tabId, blockerOf, [])) ?? ""; } catch {}
  if (!kind) return result;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  result.content.push({ type: "text", text: BLOCKER_NOTE[kind] });
  result.blocker = { kind, url: tab?.url ?? "" };
  return result;
}

// ---------------------------------------------------------------- tools

async function run(agent, tool, a) {
  switch (tool) {
    case "tabs": {
      const mine = (await agentTabs(agent)).map(brief);
      if (!a.all) return text({ agent, tabs: mine });
      const every = (await chrome.tabs.query({})).map(brief);
      return text({ agent, tabs: mine, otherTabs: every.filter((t) => !mine.some((m) => m.tabId === t.tabId)) });
    }
    case "tab_new": {
      const tab = await chrome.tabs.create({ url: a.url ? withScheme(a.url) : "about:blank", active: true });
      await intoGroup(agent, tab.id);
      if (a.url) await waitLoaded(tab.id);
      void cursor(tab.id, agent, "show");
      return withBlocker(tab.id, text(brief(await chrome.tabs.get(tab.id))));
    }
    case "tab_adopt": {
      const tab = await chrome.tabs.get(a.tabId);
      await intoGroup(agent, tab.id);
      return text({ adopted: brief(tab) });
    }
    case "tab_close": {
      const t = await tabFor(agent, a.tabId);
      await chrome.tabs.remove(t.id);
      return text(`Closed tab ${t.id}.`);
    }
    case "navigate": {
      if (a.tabId == null && !(await agentTabs(agent)).length) {
        // First page for this agent: open its tab rather than failing.
        if (/^(back|forward|reload)$/.test(a.url)) throw new Error(`${agent} has no tab yet.`);
        const tab = await chrome.tabs.create({ url: withScheme(a.url), active: true });
        await intoGroup(agent, tab.id);
        await waitLoaded(tab.id);
        void cursor(tab.id, agent, "show");
        return withBlocker(tab.id, text(brief(await chrome.tabs.get(tab.id))));
      }
      const t = await tabFor(agent, a.tabId);
      if (a.url === "back") await chrome.tabs.goBack(t.id);
      else if (a.url === "forward") await chrome.tabs.goForward(t.id);
      else if (a.url === "reload") await chrome.tabs.reload(t.id);
      else await chrome.tabs.update(t.id, { url: withScheme(a.url) });
      await sleep(150);
      await waitLoaded(t.id);
      void cursor(t.id, agent, "show");
      return withBlocker(t.id, text(brief(await chrome.tabs.get(t.id))));
    }
    case "read_page": {
      const t = await shown(await tabFor(agent, a.tabId));
      const r = await inPage(t.id, snapshotPage, [a.filter === "all" ? "all" : "interactive", a.max ?? 400]);
      return withBlocker(t.id, text(`${r.title}\n${r.url}\nviewport ${r.viewport}\n\n${r.lines.join("\n")}${r.note ? `\n\n(${r.note})` : ""}`));
    }
    case "find": {
      const t = await shown(await tabFor(agent, a.tabId));
      const hits = await inPage(t.id, findInPage, [a.query, 30]);
      return text(hits.length ? hits.join("\n") : `Nothing on the page matches "${a.query}".`);
    }
    case "page_text": {
      const t = await tabFor(agent, a.tabId);
      const r = await inPage(t.id, pageText, [a.max ?? 40000]);
      return text(`${r.title}\n${r.url}\n\n${r.text}`);
    }
    case "form_input": {
      const t = await shown(await tabFor(agent, a.tabId));
      const at = await inPage(t.id, locateRef, [a.ref]);
      await cursor(t.id, agent, "move", at);
      void cursor(t.id, agent, "type", { text: typeof a.value === "string" ? a.value : String(a.value) });
      await inPage(t.id, fillRef, [a.ref, a.value]);
      return text(`Set ${a.ref}.`);
    }
    case "computer": {
      const t = await shown(await tabFor(agent, a.tabId));
      await dbg(t.id);
      guardDialog(t.id);
      const act = a.action;
      if (act === "screenshot") {
        // The agent sees the page, not its own cursor: hide it, let one
        // frame paint, copy that frame.
        await cursor(t.id, agent, "hide");
        await sleep(50);
        try { return await screenshot(t); } finally { void cursor(t.id, agent, "unhide"); }
      }
      if (act === "wait") { await sleep(Math.min(30, a.duration ?? 1) * 1000); return text("Waited."); }
      if (act === "type") {
        void cursor(t.id, agent, "type", { text: String(a.text ?? "") });
        await cdp(t.id, "Input.insertText", { text: String(a.text ?? "") });
        return text("Typed.");
      }
      if (act === "key") {
        void cursor(t.id, agent, "key", { text: prettyKeys(String(a.text ?? "")) });
        await pressKeys(t.id, String(a.text ?? ""));
        return text(`Pressed ${a.text}.`);
      }
      const { x, y } = await point(t.id, a);
      await cursor(t.id, agent, "move", { x, y });
      if (act === "hover") { await cdp(t.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); return text(`Hovering at ${x},${y}.`); }
      if (act === "scroll") {
        const n = (a.scroll_amount ?? 3) * 100;
        const dir = a.scroll_direction ?? "down";
        await cdp(t.id, "Input.dispatchMouseEvent", {
          type: "mouseWheel", x, y,
          deltaX: dir === "left" ? -n : dir === "right" ? n : 0,
          deltaY: dir === "up" ? -n : dir === "down" ? n : 0,
        });
        return text(`Scrolled ${dir}.`);
      }
      const clicks = act === "double_click" ? 2 : act === "triple_click" ? 3 : 1;
      const button = act === "right_click" ? "right" : "left";
      if (!/click$/.test(act)) throw new Error(`Unknown action "${act}".`);
      if (a._ask && !a.confirmed && button === "left") {
        const label = (await inPage(t.id, labelAt, [x, y])) ?? "";
        if (RISKY.test(label)) {
          const r = text(`Waiting for the user to allow: click "${label}".`);
          r.needsConfirm = { what: `Click "${label}"`, url: t.url ?? "" };
          return r;
        }
      }
      await cursor(t.id, agent, "click", { x, y, button });
      await mouse(t.id, x, y, { button, clicks });
      await sleep(400);
      return withBlocker(t.id, text(`${act} at ${x},${y}.`));
    }
    case "javascript": {
      const t = await tabFor(agent, a.tabId);
      await dbg(t.id);
      guardDialog(t.id);
      const r = await cdp(t.id, "Runtime.evaluate", { expression: a.code, awaitPromise: true, returnByValue: true, replMode: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return text(r.result.value === undefined ? String(r.result.description ?? "undefined") : r.result.value);
    }
    case "console": {
      const t = await tabFor(agent, a.tabId);
      await dbg(t.id);
      let list = consoleLog.get(t.id) ?? [];
      if (a.pattern) { const re = new RegExp(a.pattern, "i"); list = list.filter((m) => re.test(m.text)); }
      if (a.onlyErrors) list = list.filter((m) => m.level === "error" || m.level === "exception");
      if (a.clear) consoleLog.delete(t.id);
      return text(list.length ? list.slice(-(a.limit ?? 100)).map((m) => `[${m.level}] ${m.text}`).join("\n") : "No console messages yet (recording starts when Maestro first controls the tab).");
    }
    case "network": {
      const t = await tabFor(agent, a.tabId);
      await dbg(t.id);
      let list = [...(networkLog.get(t.id)?.values() ?? [])];
      if (a.pattern) { const re = new RegExp(a.pattern, "i"); list = list.filter((e) => re.test(e.url)); }
      if (a.clear) networkLog.delete(t.id);
      return text(list.length ? list.slice(-(a.limit ?? 100)).map((e) => `${e.method} ${e.status || e.error || "…"} ${e.url}`).join("\n") : "No requests yet (recording starts when Maestro first controls the tab).");
    }
    case "peek": {
      // Maestro's live view: a small frame of the agent's current tab. Never
      // brings the tab forward, so watching never gets in the agent's way.
      const t = await tabFor(agent, a.tabId);
      // As wide as Maestro shows it (the small card, or the large view), so a
      // large view is sharp and a small one stays light.
      const maxW = Math.max(320, Math.min(2560, Number(a.maxW) || 720));
      const quality = Math.max(40, Math.min(90, Number(a.quality) || 60));
      const img = await grab(t, maxW, quality);
      return { content: [{ type: "image", data: img.data, mimeType: "image/jpeg" }], tab: brief(t), dialog: dialogs.get(t.id) ?? null };
    }
    case "reload": {
      // Maestro saw this profile running an older copy than the folder on
      // disk: load the new one. The port drops and reconnects by itself.
      setTimeout(() => chrome.runtime.reload(), 100);
      return text("Reloading.");
    }
    case "upload": {
      // Attach files from this computer: Chrome reads them from disk itself.
      const t = await shown(await tabFor(agent, a.tabId));
      await dbg(t.id);
      guardDialog(t.id);
      const files = (a.paths ?? []).map(String);
      if (!files.length) throw new Error("Give the files to attach (full paths).");
      const mark = "m" + Math.random().toString(36).slice(2);
      const at = await inPage(t.id, markForUpload, [a.ref, mark]);
      if (at.input) {
        // The cursor goes to the field, so a watcher sees where the files went.
        await cursor(t.id, agent, "move", at);
        const doc = await cdp(t.id, "DOM.getDocument", { depth: 0 });
        const q = await cdp(t.id, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: `[data-maestro-upload="${mark}"]` });
        await cdp(t.id, "DOM.setFileInputFiles", { files, nodeId: q.nodeId });
        await inPage(t.id, unmarkUpload, [mark]);
      } else {
        // A button that opens the file chooser: catch the chooser and fill it.
        await cdp(t.id, "Page.setInterceptFileChooserDialog", { enabled: true });
        const opened = new Promise((done) => {
          const on = (src, m, p) => {
            if (src.tabId === t.id && m === "Page.fileChooserOpened") { chrome.debugger.onEvent.removeListener(on); clearTimeout(tm); done(p); }
          };
          const tm = setTimeout(() => { chrome.debugger.onEvent.removeListener(on); done(null); }, 4000);
          chrome.debugger.onEvent.addListener(on);
        });
        await cursor(t.id, agent, "move", at);
        await cursor(t.id, agent, "click", { ...at, button: "left" });
        await mouse(t.id, at.x, at.y);
        const p = await opened;
        await cdp(t.id, "Page.setInterceptFileChooserDialog", { enabled: false });
        if (!p) throw new Error("That didn't open a file chooser. Give the ref of the file field, or of the button that opens it.");
        await cdp(t.id, "DOM.setFileInputFiles", { files, backendNodeId: p.backendNodeId });
      }
      void cursor(t.id, agent, "key", { text: `Attached ${files.length} file${files.length === 1 ? "" : "s"}` });
      return text(`Attached ${files.map((f) => f.split(/[\\/]/).pop()).join(", ")}.`);
    }
    case "resize": {
      // The window the agent's tab is in (it's the user's window: say so).
      const t = await tabFor(agent, a.tabId);
      const w = Math.max(400, Math.min(3840, Math.round(Number(a.width) || 1280)));
      const h = Math.max(300, Math.min(2160, Math.round(Number(a.height) || 800)));
      await chrome.windows.update(t.windowId, { state: "normal", width: w, height: h });
      const win = await chrome.windows.get(t.windowId);
      return text(`The window is now ${win.width}x${win.height}.`);
    }
    case "gif": {
      if (a.action === "start") {
        const t = await tabFor(agent, a.tabId);
        startRecording(agent, t.id);
        return text("Recording. Do the steps, then call browser_gif with action stop. Frames are taken while the tab is showing.");
      }
      const rec = stopRecording(agent);
      if (!rec) throw new Error("Nothing is being recorded. Start with action start.");
      if (!rec.frames.length) throw new Error("No frames were recorded: the tab was not showing.");
      const gif = await encodeGif(rec.frames);
      const secs = Math.round((Date.now() - rec.started) / 1000);
      const r = text(`Recorded ${rec.frames.length} frames over ${secs}s.`);
      r.gif = gif;
      return r;
    }
    case "dialog": {
      const t = await tabFor(agent, a.tabId);
      await dbg(t.id);
      if (!dialogs.has(t.id)) return text("No dialog is open.");
      await cdp(t.id, "Page.handleJavaScriptDialog", { accept: !!a.accept, promptText: a.text });
      dialogs.delete(t.id);
      return text(a.accept ? "Accepted the dialog." : "Dismissed the dialog.");
    }
    default:
      throw new Error(`Unknown browser tool "${tool}".`);
  }
}

connect();
