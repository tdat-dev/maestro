// Prune stale Rust incremental-compilation caches out of src-tauri/target.
//
// Why this exists: cargo writes one incremental cache per (crate, build
// configuration) as `<crate>-<hash>/`, and it never removes the ones it has
// stopped using. Every config change — `tauri dev` vs `tauri build` vs
// `cargo test`, a feature flag, a profile edit — mints a fresh hash and orphans
// the old directory forever. On 2026-07-30 this repo held ten caches for
// `maestro_lib` alone at ~850 MB each: 8.4 GB of the 20 GB target, all dead.
//
// Deleting a cache is never destructive — it is a build accelerator, not build
// output. The worst case is that one crate recompiles from scratch next build.
// So the rule is deliberately blunt: anything untouched for MAX_AGE_DAYS goes.
// Caches you are actually using are touched on every build and never age out.
//
// Runs automatically before `npm run tauri:dev` (see the `pretauri:dev` script
// in package.json). Also runnable on its own:
//   node tools/prune_build_cache.mjs            # prune, default age
//   node tools/prune_build_cache.mjs --days 3   # more aggressive
//   node tools/prune_build_cache.mjs --dry-run  # report only

import { readdir, stat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_AGE_DAYS = 7;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "target");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const daysArg = args.indexOf("--days");
const maxAgeDays = daysArg >= 0 ? Number(args[daysArg + 1]) : MAX_AGE_DAYS;

if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
  console.error(`prune: --days needs a non-negative number, got ${args[daysArg + 1]}`);
  process.exit(2);
}

/** Total bytes under a directory. Symlinks are counted as their own (tiny)
 *  size and never followed — walking a junction would wander out of target
 *  entirely and, worse, invite a delete of whatever it points at. */
async function dirSize(path) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0; // vanished mid-walk (a build running alongside us)
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = join(path, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else {
      try {
        total += (await stat(p)).size;
      } catch {
        /* same race */
      }
    }
  }
  return total;
}

const gb = (bytes) => (bytes / 1024 ** 3).toFixed(2);

async function pruneProfile(profile) {
  const incremental = join(ROOT, profile, "incremental");
  let entries;
  try {
    entries = await readdir(incremental, { withFileTypes: true });
  } catch {
    return { freed: 0, removed: 0, kept: 0 }; // no cache for this profile yet
  }

  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let freed = 0, removed = 0, kept = 0;

  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const path = join(incremental, e.name);
    let mtime;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (mtime >= cutoff) {
      kept++;
      continue;
    }
    const size = await dirSize(path);
    if (!dryRun) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (err) {
        console.warn(`prune: could not remove ${e.name}: ${err.message}`);
        continue;
      }
    }
    freed += size;
    removed++;
  }
  return { freed, removed, kept };
}

let freed = 0, removed = 0, kept = 0;
for (const profile of ["debug", "release"]) {
  const r = await pruneProfile(profile);
  freed += r.freed;
  removed += r.removed;
  kept += r.kept;
}

if (removed) {
  const verb = dryRun ? "would free" : "freed";
  console.log(`prune: ${verb} ${gb(freed)} GB from ${removed} stale incremental cache(s), kept ${kept}`);
}
