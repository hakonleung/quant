/**
 * Shared SVG-axis text style + label-width constants. Lifted into a
 * non-`'use client'` file so the orchestrator and every leaf piece
 * can import them without going through the React-only files.
 */

const AXIS_FONT_FAMILY = 'JetBrains Mono, ui-monospace, monospace';
const AXIS_FONT_SIZE = 8;

/** Approximate width (px) of a "MM-DD" date label at AXIS_FONT_SIZE. */
export const DATE_LABEL_W = 28;

/** Pre-computed reusable axis-text style — keeps render hot-path tidy. */
export const AXIS_TEXT_STYLE: React.CSSProperties = {
  fontFamily: AXIS_FONT_FAMILY,
  fontSize: `${String(AXIS_FONT_SIZE)}px`,
};
