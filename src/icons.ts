// The small drawn icons the Inbox shares, so a close is the same ✕ everywhere
// (one stroke, one size) instead of a text glyph here and an SVG there.

const svg = (size: number, path: string, width = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

/** Close / take out: a cross. */
export const ICON_CLOSE = svg(14, `<path d="M6 6l12 12M18 6L6 18"/>`, 2.2);
/** Open full size: arrows out to two corners. */
export const ICON_EXPAND = svg(14, `<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>`);
/** The side panel of a conversation. */
export const ICON_PANEL = svg(16, `<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>`, 1.8);
