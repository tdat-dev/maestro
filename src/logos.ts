/**
 * Monochrome brand-style glyphs for each CLI, keyed by preset `badge`. Rendered
 * inside the colored monogram tile (dark glyph on the brand color), so they read
 * as recognizable marks instead of a bare first letter.
 *
 * These are simple, original icon glyphs evocative of each tool — not exact
 * trademark reproductions. Any badge without an entry falls back to its letter.
 * All use `currentColor` so they inherit the tile's ink color.
 */
const S = (inner: string): string =>
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const F = (inner: string): string =>
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">${inner}</svg>`;

export const CLI_LOGOS: Record<string, string> = {
  // Claude — radiating starburst / spark.
  claude: S(
    '<path d="M20 12H4M12 4v16M17.66 6.34 6.34 17.66M17.66 17.66 6.34 6.34" stroke-width="1.7"/>',
  ),
  // Codex — orbit ring with a core (AI/atom).
  codex: S('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  // Gemini — four-point sparkle.
  gemini: F(
    '<path d="M12 3c.4 5.2 3.8 8.6 9 9-5.2.4-8.6 3.8-9 9-.4-5.2-3.8-8.6-9-9 5.2-.4 8.6-3.8 9-9Z"/>',
  ),
  // Aider — pair-programming chat bubble.
  aider: F(
    '<path d="M5 5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7l-4.5 3.3a.6.6 0 0 1-1-.5V16H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/>',
  ),
  // Cursor — pointer arrow.
  cursor: F('<path d="M6 3.5 18.5 12 12.4 13 16 20.4 13.4 21.6 9.8 14.2 6 18Z"/>'),
  // opencode — angle brackets </>.
  opencode: S('<path d="M9 8 5 12l4 4M15 8l4 4-4 4M13.5 6l-3 12"/>'),
  // Qwen — looped Q.
  qwen: S('<circle cx="11" cy="11" r="6"/><path d="m14.5 14.5 4 4"/>'),
  // Copilot — paired goggles.
  copilot: S('<rect x="3.5" y="9" width="7.5" height="7" rx="3.5"/><rect x="13" y="9" width="7.5" height="7" rx="3.5"/><path d="M11 12.5h2"/>'),
  // PowerShell / generic shell — prompt chevron + caret.
  shell: S('<path d="M6 8l4 4-4 4M13 16h5"/>'),
  // CMD — console window with a prompt.
  cmd: S('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l2.5 2.5L7 15" stroke-width="1.7"/>'),
  // Custom command — eight-ray asterisk (anything).
  custom: S('<path d="M12 5v14M5 12h14M7.1 7.1l9.8 9.8M16.9 7.1l-9.8 9.8" stroke-width="1.7"/>'),
};
