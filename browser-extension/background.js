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

import { snapshotPage, locateRef, fillRef, findInPage, pageText } from "./page.js";

const HOST = "com.maestro.browser";
const COLORS = ["blue", "purple", "green", "orange", "pink", "cyan", "red", "yellow"];
const MAX_CONSOLE = 300;
const MAX_NETWORK = 300;

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
  if (gid == null) return null;
  try { await chrome.tabGroups.get(gid); return gid; } catch { return null; }
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
  if (!mine.length) throw new Error(`${agent} has no tab yet. Call browser_tab_new first.`);
  return mine.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
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

async function screenshot(tabId, retried = false) {
  const m = await cdp(tabId, "Page.getLayoutMetrics");
  const v = m.cssVisualViewport;
  const shot = await Promise.race([
    cdp(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 1 },
    }),
    sleep(8000).then(() => null),
  ]);
  if (!shot) {
    if (retried) throw new Error("The tab did not paint a screenshot in time.");
    // A tab in the background may not paint: bring it forward once.
    await chrome.tabs.update(tabId, { active: true });
    await sleep(400);
    return screenshot(tabId, true);
  }
  return {
    content: [
      { type: "image", data: shot.data, mimeType: "image/jpeg" },
      { type: "text", text: `Screenshot ${Math.round(v.clientWidth)}x${Math.round(v.clientHeight)}; click coordinates use these pixels.` },
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
      return text(brief(await chrome.tabs.get(tab.id)));
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
      const t = await tabFor(agent, a.tabId);
      if (a.url === "back") await chrome.tabs.goBack(t.id);
      else if (a.url === "forward") await chrome.tabs.goForward(t.id);
      else if (a.url === "reload") await chrome.tabs.reload(t.id);
      else await chrome.tabs.update(t.id, { url: withScheme(a.url) });
      await sleep(150);
      await waitLoaded(t.id);
      return text(brief(await chrome.tabs.get(t.id)));
    }
    case "read_page": {
      const t = await tabFor(agent, a.tabId);
      const r = await inPage(t.id, snapshotPage, [a.filter === "all" ? "all" : "interactive", a.max ?? 400]);
      return text(`${r.title}\n${r.url}\nviewport ${r.viewport}\n\n${r.lines.join("\n")}${r.note ? `\n\n(${r.note})` : ""}`);
    }
    case "find": {
      const t = await tabFor(agent, a.tabId);
      const hits = await inPage(t.id, findInPage, [a.query, 30]);
      return text(hits.length ? hits.join("\n") : `Nothing on the page matches "${a.query}".`);
    }
    case "page_text": {
      const t = await tabFor(agent, a.tabId);
      const r = await inPage(t.id, pageText, [a.max ?? 40000]);
      return text(`${r.title}\n${r.url}\n\n${r.text}`);
    }
    case "form_input": {
      const t = await tabFor(agent, a.tabId);
      await inPage(t.id, fillRef, [a.ref, a.value]);
      return text(`Set ${a.ref}.`);
    }
    case "computer": {
      const t = await tabFor(agent, a.tabId);
      await dbg(t.id);
      guardDialog(t.id);
      const act = a.action;
      if (act === "screenshot") return screenshot(t.id);
      if (act === "wait") { await sleep(Math.min(30, a.duration ?? 1) * 1000); return text("Waited."); }
      if (act === "type") { await cdp(t.id, "Input.insertText", { text: String(a.text ?? "") }); return text("Typed."); }
      if (act === "key") { await pressKeys(t.id, String(a.text ?? "")); return text(`Pressed ${a.text}.`); }
      const { x, y } = await point(t.id, a);
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
      await mouse(t.id, x, y, { button, clicks });
      await sleep(250);
      return text(`${act} at ${x},${y}.`);
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
      await dbg(t.id);
      const m = await cdp(t.id, "Page.getLayoutMetrics");
      const v = m.cssVisualViewport;
      const scale = Math.min(1, 720 / v.clientWidth);
      const shot = await Promise.race([
        cdp(t.id, "Page.captureScreenshot", { format: "jpeg", quality: 55, clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale } }),
        sleep(2500).then(() => null),
      ]);
      if (!shot) throw new Error("The tab isn't showing right now.");
      return { content: [{ type: "image", data: shot.data, mimeType: "image/jpeg" }], tab: brief(t), dialog: dialogs.get(t.id) ?? null };
    }
    case "reload": {
      // Maestro saw this profile running an older copy than the folder on
      // disk: load the new one. The port drops and reconnects by itself.
      setTimeout(() => chrome.runtime.reload(), 100);
      return text("Reloading.");
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
