# Maestro — Intro/Launch Animation Design

**Date:** 2026-06-05
**Status:** Approved

## Goal
A professional, polished launch animation that plays every time the app opens
(~1.6s), themed around the Maestro brand (gradient "M" mark, AI-fleet
orchestration). Concept: **"M draws itself + signal field"**.

## Constraints
- Pure CSS + SVG. No new dependencies. Animate only `transform`, `opacity`,
  `stroke-dashoffset`, `filter` (GPU-friendly, no layout thrash).
- Plays on every launch, fast (~1.6s).
- Respect `prefers-reduced-motion`: skip entirely, show Home instantly.
- Touch only `index.html` (overlay + keyframes) and a small hook in
  `src/main.ts`. Do not change terminal/workspace logic.

## Structure
- A full-screen overlay `#intro` (same dark bg) layered above Home, containing
  an enlarged "M" SVG + a signal-field layer (dots + ripple ring).
- Home content (`.hero`, `.card-primary`, `.card-row`, recents, footer) starts
  hidden and rises in as the overlay fades.
- `body.intro-playing` gates the entrance animations; removed/auto-cleared at end.

## Timeline (~1.6s)
| t (s)     | Effect |
|-----------|--------|
| 0.0–0.6   | "M" stroke-draws (stroke-dashoffset 1→0, `pathLength=1`), faint→full |
| 0.4–0.9   | Glow bloom around M (radial scale-up then settle) |
| 0.7–1.3   | ~7 signal dots radiate from center (staggered) + 1 expanding ripple ring |
| 1.0–1.6   | Overlay fades out; Home staggers in (wordmark → tagline → primary card → 2 cards → recents/footer, ~70ms apart, rise+fade) |

## Reduced motion
`@media (prefers-reduced-motion:reduce)`: `#intro` hidden, all entrance
animations disabled, Home at final state immediately.

## Implementation notes
- Use `pathLength="1"` on the M `<path>` so `stroke-dasharray:1` normalizes the
  draw regardless of actual path length.
- Overlay ends at `opacity:0; pointer-events:none` via `animation-fill-mode:
  forwards`; `main.ts` removes it from the DOM after ~1.7s to free it (guarded so
  it never blocks Home interaction).
- No audio in v1 (optional future enhancement).
