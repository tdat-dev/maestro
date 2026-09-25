// Screenshots for the Chrome Web Store listing (1280x800), from the real
// extension code and real Maestro captures, in a throwaway headless Chrome:
//   node tools/store_shots.mjs <maestro-live-view.png> <maestro-asks.png>
// → browser-extension/store/1-cursor.png … 4-popup.png
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
const ext = path.join(root, "browser-extension");
const out = path.join(ext, "store");
fs.mkdirSync(out, { recursive: true });
const [liveView, asks] = process.argv.slice(2);
const W = 1280, H = 800;
const fileUrl = (p) => "file:///" + p.replace(/\\/g, "/");

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "store-shots-"));
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=9577", `--user-data-dir=${prof}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch("http://127.0.0.1:9577/json")).json()).find((t) => t.type === "page"); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (x) => send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true });
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, name), Buffer.from(r.result.data, "base64"));
  console.log(path.join(out, name));
};
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Page.enable");

// 1. The agent's cursor at work on a real page.
await send("Page.navigate", { url: "https://vi.wikipedia.org/wiki/Tr%C3%AD_tu%E1%BB%87_nh%C3%A2n_t%E1%BA%A1o" });
await sleep(3500);
const cursor = fs.readFileSync(path.join(ext, "cursor.js"), "utf8").replace("export function", "function");
await ev(`${cursor}; window.cursorAct = cursorAct;`);
const O = `{ name: "Ana", color: "#d01884", from: [900, 560] }`;
// A link well inside the first screen, so the cursor is in the picture.
const at = await ev(`(() => { const a = [...document.querySelectorAll("#mw-content-text p a")].find((a) => { const r = a.getBoundingClientRect(); return r.top > 380 && r.top < 560 && r.left > 300 && r.width > 40; }); const r = a.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
const [x, y] = at.result.result.value;
await ev(`cursorAct("move", Object.assign(${O}, { x: ${x}, y: ${y} }))`);
await ev(`cursorAct("click", Object.assign(${O}, { x: ${x}, y: ${y} }))`);
await sleep(130);
await shot("1-cursor.png");

// 2–3. Maestro itself, fitted to 1280x800 without stretching.
const fit = async (src, name, position) => {
  const html = `<!doctype html><body style="margin:0;background:#050506;width:${W}px;height:${H}px;overflow:hidden">
<img src="${fileUrl(src)}" style="width:100%;height:100%;object-fit:cover;object-position:${position}"></body>`;
  const f = path.join(prof, `${name}.html`);
  fs.writeFileSync(f, html);
  await send("Page.navigate", { url: fileUrl(f) });
  await sleep(700);
  await shot(name);
};
if (liveView) await fit(liveView, "2-live-view.png", "center top");
if (asks) await fit(asks, "3-ask-first.png", "right top");

// 4. The popup, as Chrome shows it, on a quiet backdrop.
const stub = `window.chrome = { runtime: { sendMessage: async () => ({ state: "ready", detail: "", email: "you@gmail.com", agents: [{ name: "Ana", tabs: 1 }, { name: "Eli", tabs: 2 }] }) } };`;
const popup = fs.readFileSync(path.join(ext, "popup.html"), "utf8")
  .replace('<script src="popup.js" type="module"></script>', `<script>${stub}</script><script type="module">${fs.readFileSync(path.join(ext, "popup.js"), "utf8")}</script>`)
  .replace('src="icons/32.png"', `src="${fileUrl(path.join(ext, "icons", "32.png"))}"`);
const pf = path.join(prof, "popup.html");
fs.writeFileSync(pf, popup);
const stage = `<!doctype html><body style="margin:0;width:${W}px;height:${H}px;display:grid;place-items:center;background:radial-gradient(900px 500px at 50% 40%,#1b1b22,#08080a)">
<iframe src="${fileUrl(pf)}" style="width:300px;height:292px;border:0;border-radius:12px;box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08);transform:scale(1.6)"></iframe></body>`;
const sf = path.join(prof, "stage.html");
fs.writeFileSync(sf, stage);
await send("Page.navigate", { url: fileUrl(sf) });
await sleep(900);
await shot("4-popup.png");

ws.close();
chrome.kill();
await sleep(500);
fs.rmSync(prof, { recursive: true, force: true });
process.exit(0);
