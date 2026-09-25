// Pack "Maestro for Chrome" for the Chrome Web Store:
//   node tools/pack_extension.mjs  →  dist/maestro-for-chrome-<version>.zip
//
// The store refuses a manifest with a "key" (it assigns its own id), so the
// packed copy leaves it out. The unpacked extension keeps it: that is what
// gives developers the same id in every folder. Maestro's native host allows
// both ids (see STORE_EXTENSION_ID in src-tauri/src/browser/mod.rs).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
const src = path.join(root, "browser-extension");
const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
delete manifest.key;

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-ext-"));
const SKIP = new Set(["logs", "PRIVACY.md", "store"]);
const copy = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const f = path.join(from, e.name), t = path.join(to, e.name);
    if (e.isDirectory()) copy(f, t);
    else fs.copyFileSync(f, t);
  }
};
copy(src, stage);
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const out = path.join(root, "dist", `maestro-for-chrome-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
// .NET's zip with "/" in entry names: Windows PowerShell's Compress-Archive
// writes backslashes ("icons\128.png"), which Chrome does not find.
const ps = [
  "Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem",
  `$zip = [IO.Compression.ZipFile]::Open('${out}', 'Create')`,
  `Get-ChildItem -Recurse -File '${stage}' | ForEach-Object {`,
  `  $name = $_.FullName.Substring(${stage.length + 1}).Replace([string][char]92, '/')`,
  "  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name)",
  "}",
  "$zip.Dispose()",
].join("\n");
execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
