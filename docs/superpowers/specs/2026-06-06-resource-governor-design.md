# Resource Governor — Design

**Date:** 2026-06-06
**Status:** Approved (design)
**Milestone:** M1 (multi-agent dashboard)

## Summary

Stop Maestro from overwhelming the machine when spawning many agents. Add a
lightweight resource monitor (RAM/CPU), a live topbar meter, an auto-derived
(but overridable) cap on concurrent live agents, and a queue that boots pending
agents only when there's headroom. Directly addresses the real failure mode:
spawning a 6–8 agent crew on a 16 GB box already at ~83 % RAM can hang the
whole system.

## Decisions (from brainstorming)

- **Over the limit → queue + auto-boot.** Excess agents mount as `queued` panes
  and boot automatically as others exit or RAM frees up.
- **Cap = auto + adjustable.** Default derived from total RAM; overridable in
  Settings.
- **Live meter in the topbar** (RAM % · CPU %), colour-coded near thresholds.

## Scope

In: resource sampling, topbar meter, concurrency cap, resource-gated boot queue.
Out (deferred to later M1): headless/background agents (needs the control-plane
adapter layer); per-agent RAM attribution; CPU-based throttling beyond display.

## Components

### Rust — `sysmon` (new module)

A sampler thread started in `setup` that, every ~2 s, reads:
- RAM: `GlobalMemoryStatusEx` → total / available bytes (the `windows` crate is
  already a dependency).
- CPU: `GetSystemTimes` delta between samples → system-wide busy %.

It emits a Tauri event `sysmon` with `{ ramPct, freeGb, cpuPct, totalGb }`.
No new command is required for the meter (push model); a `get_resources`
command may be added for a synchronous read at boot. Failures are swallowed —
the sampler logs and keeps going.

### Frontend — `governor.ts` (new module)

Pure, unit-testable core plus a thin wiring layer:

- `safeCap(totalGb: number, override: number | null): number` — `override` when
  set, else `floor(totalGb / PER_AGENT_GB)` (PER_AGENT_GB ≈ 1.5), clamped to a
  minimum of 2.
- `canBoot(live: number, cap: number, freeGb: number, floorGb: number): boolean`
  — `live < cap && freeGb > floorGb` (floorGb ≈ 1.5).
- Wiring: listen for `sysmon` events → update the meter and the latest
  resource snapshot; expose a boot gate the spawn flow consults.

### Frontend — boot queue (extend existing)

`spawnCrew` already mounts panes and boots through `runLimited`. Change: mount
every agent as `queued`, then a governor-driven loop boots the next queued pane
only while `canBoot(...)` holds. Re-evaluate the loop on (a) each `sysmon` tick
and (b) every `pty-exit`. This replaces the fixed `MAX_CONCURRENT_BOOT`
throttle with a resource-aware one (keep a hard ceiling as a safety bound).

### Settings

Add a **"Max concurrent agents"** control to the existing Settings modal:
empty/Auto = derived cap; a number overrides it. Persisted via `settings.ts`
(`maestro.maxAgents`).

### UI — topbar meter

Next to the existing `.stats` block: `RAM 83% · CPU 30%`, updated ~2 s.
Neutral colour normally; amber as RAM nears the floor; red at/over it. Hidden
in browser preview (no `sysmon` events).

## Data Flow

```
Rust sysmon thread (2s) --emit "sysmon" {ramPct,freeGb,cpuPct,totalGb}--> frontend
  governor: update meter + snapshot; cap = safeCap(totalGb, override)
spawnCrew: mount all panes "queued"
  bootLoop: while canBoot(live,cap,freeGb,floor) -> boot next queued
pty-exit / sysmon tick -> bootLoop re-runs -> boots next queued
Settings "Max concurrent agents" -> persist override -> cap recomputed
```

## Error Handling

- `sysmon` unavailable / sampling error → governor falls back to a count-only
  cap (boot by `live < cap`, no RAM gating) so spawning still works.
- Browser preview (no Tauri) → no `sysmon` events; meter hidden; queue boots by
  count only.
- Override parsing: non-numeric/blank → Auto.

## Testing

- **Unit:** `governor.test.ts` — `safeCap` (auto math, override wins, min
  clamp); `canBoot` (cap boundary, RAM floor boundary, combined).
- **Manual:** spawn a large crew on a loaded machine → confirm panes queue and
  auto-boot as agents exit / RAM frees; meter tracks usage and colours change.

## Out of Scope (YAGNI)

- Headless background agents (separate M1 piece — control plane).
- Per-process RAM accounting / killing the heaviest agent.
- CPU-based boot gating (CPU is shown but not used to gate).
- Persisting the queue across restarts.
