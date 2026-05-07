/**
 * Bottom-of-widget key-hint bar.
 *
 * Pure renderer (CLAUDE.md §2.5.1). The engine appends the hint bar after
 * each frame; if a widget returns an empty hint list in dev mode, the
 * registry guard throws.
 */

import { ANSI, paint } from '../render/ansi.js';
import { visualWidth } from '../render/width.js';
import type { KeyHint } from './types.js';

export interface RenderHintsOptions {
  readonly width: number;
  readonly inFilter?: boolean;
  readonly hasSelection?: boolean;
}

export function renderHints(hints: readonly KeyHint[], opts: RenderHintsOptions): string {
  const visible = hints.filter((h) => isVisible(h, opts));
  if (visible.length === 0) return '';

  const segments = visible.map((h) => renderSegment(h));

  // Pack segments greedily; wrap on width overflow.
  const lines: string[] = [];
  let current = '';
  let currentW = 0;
  const sepW = 3; // " · "
  for (const seg of segments) {
    const w = visualWidth(seg);
    const need = currentW === 0 ? w : currentW + sepW + w;
    if (currentW > 0 && need > opts.width) {
      lines.push(current);
      current = seg;
      currentW = w;
    } else {
      current = currentW === 0 ? seg : `${current} ${paint('·', ANSI.gray)} ${seg}`;
      currentW = need;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.join('\n');
}

function isVisible(hint: KeyHint, opts: RenderHintsOptions): boolean {
  switch (hint.when ?? 'always') {
    case 'always':
      return true;
    case 'whenItemSelected':
      return opts.hasSelection === true;
    case 'whenFilter':
      return opts.inFilter === true;
    default:
      return true;
  }
}

function renderSegment(hint: KeyHint): string {
  const keyText = hint.keys.join('/');
  const danger = hint.danger === true;
  const keyPaint = danger
    ? paint(keyText, ANSI.red, ANSI.bold)
    : paint(keyText, ANSI.cyan, ANSI.bold);
  const labelPaint = danger ? paint(hint.label, ANSI.red) : paint(hint.label, ANSI.gray);
  return `${keyPaint} ${labelPaint}`;
}
