import { describe, expect, it } from 'vitest';
import { renderHints } from '../widgets/hint-bar.js';
import { stripAnsi } from '../render/ansi.js';

describe('renderHints', () => {
  it('returns empty string when no hints (boundary)', () => {
    expect(renderHints([], { width: 80 })).toBe('');
  });

  it('hides whenItemSelected hint without selection', () => {
    const out = renderHints(
      [
        { keys: ['↑', '↓'], label: 'move' },
        { keys: ['Enter'], label: 'pick', when: 'whenItemSelected' },
      ],
      { width: 80, hasSelection: false },
    );
    expect(stripAnsi(out)).toContain('move');
    expect(stripAnsi(out)).not.toContain('pick');
  });

  it('hides whenFilter hint outside filter mode', () => {
    const out = renderHints([{ keys: ['type'], label: 'filter', when: 'whenFilter' }], {
      width: 80,
      inFilter: false,
    });
    expect(out).toBe('');
  });

  it('paints danger hints differently', () => {
    const danger = renderHints([{ keys: ['d'], label: 'delete', danger: true }], { width: 80 });
    const safe = renderHints([{ keys: ['e'], label: 'edit' }], { width: 80 });
    // Danger should contain the red ANSI sequence; safe one should not.
    expect(danger).toContain('\x1b[31m');
    expect(safe).not.toContain('\x1b[31m');
  });

  it('wraps to multiple lines when width is too small', () => {
    const hints = Array.from({ length: 10 }, (_, i) => ({
      keys: ['k' + String(i)],
      label: 'lbl',
    }));
    const out = renderHints(hints, { width: 20 });
    expect(out.split('\n').length).toBeGreaterThan(1);
  });
});
