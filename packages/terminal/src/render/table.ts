/**
 * Monospace table renderer for the terminal.
 *
 * Pure module — no IO, no globals (CLAUDE.md §2.5.1). Output is `\n`-separated
 * lines; the xterm bridge converts `\n` to `\r\n` when writing to the terminal.
 */

import { ANSI, paint } from './ansi.js';
import { padEnd, padStart, truncate, visualWidth } from './width.js';

export interface ColumnSpec<R> {
  readonly key: keyof R & string;
  readonly header: string;
  readonly align?: 'left' | 'right';
  readonly max?: number;
  readonly format?: (value: R[keyof R & string], row: R) => string;
}

export interface RenderTableOptions {
  /** Two spaces by default. */
  readonly gap?: number;
  /** Render header + ─ separator. Defaults to true. */
  readonly header?: boolean;
  /** Highlight one row (0-based). */
  readonly highlightRow?: number;
}

/**
 * Renders rows into a monospace, CJK-aware table. Returns one string with
 * `\n`-separated lines so the engine can buffer and split at the bridge.
 */
export function renderTable<R extends Record<string, unknown>>(
  rows: readonly R[],
  schema: readonly ColumnSpec<R>[],
  opts: RenderTableOptions = {},
): string {
  const gap = ' '.repeat(opts.gap ?? 2);
  const showHeader = opts.header ?? true;

  const cells: string[][] = rows.map((row) =>
    schema.map((col) => {
      const raw =
        col.format !== undefined
          ? col.format(row[col.key] as R[keyof R & string], row)
          : stringify(row[col.key]);
      return col.max !== undefined ? truncate(raw, col.max) : raw;
    }),
  );

  // Compute column widths from header + cell widths.
  const widths = schema.map((col, i) => {
    let w = showHeader ? visualWidth(col.header) : 0;
    for (const r of cells) {
      const cell = r[i] ?? '';
      w = Math.max(w, visualWidth(cell));
    }
    return col.max !== undefined ? Math.min(w, col.max) : w;
  });

  const lines: string[] = [];

  if (showHeader) {
    const headerLine = schema
      .map((col, i) => {
        const wi = widths[i] ?? 0;
        const text = col.align === 'right' ? padStart(col.header, wi) : padEnd(col.header, wi);
        return paint(text, ANSI.dim, ANSI.bold);
      })
      .join(gap);
    lines.push(headerLine);
    lines.push(paint(widths.map((w) => '─'.repeat(w)).join(gap), ANSI.gray));
  }

  cells.forEach((row, idx) => {
    const line = row
      .map((cell, i) => {
        const wi = widths[i] ?? 0;
        const col = schema[i];
        if (col === undefined) return cell;
        return col.align === 'right' ? padStart(cell, wi) : padEnd(cell, wi);
      })
      .join(gap);
    lines.push(idx === opts.highlightRow ? paint(line, ANSI.inverse) : line);
  });

  return lines.join('\n');
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}
