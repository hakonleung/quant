import { describe, expect, it } from 'vitest';
import { renderTable } from '../render/table.js';
import { stripAnsi } from '../render/ansi.js';

interface Row {
  readonly code: string;
  readonly name: string;
  readonly price: number;
  readonly [key: string]: unknown;
}

const schema = [
  { key: 'code', header: 'CODE', max: 8 },
  { key: 'name', header: 'NAME', max: 10 },
  { key: 'price', header: 'PX', align: 'right' as const },
] as const;

describe('renderTable', () => {
  it('renders header + separator + rows (golden)', () => {
    const out = stripAnsi(
      renderTable<Row>(
        [
          { code: '600519', name: '贵州茅台', price: 1700.5 },
          { code: '000001', name: '平安银行', price: 12.34 },
        ],
        schema as readonly typeof schema[number][],
      ),
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^CODE/);
    expect(lines[1]).toMatch(/^─/);
    expect(lines[2]).toContain('600519');
    expect(lines[2]).toContain('贵州茅台');
    // right-aligned numeric column
    expect(lines[2]?.endsWith('1700.5')).toBe(true);
  });

  it('returns header only for empty rows (boundary)', () => {
    const out = stripAnsi(renderTable<Row>([], schema as readonly typeof schema[number][]));
    expect(out.split('\n')).toHaveLength(2);
  });

  it('aligns columns even with CJK in middle column', () => {
    const out = stripAnsi(
      renderTable<Row>(
        [
          { code: '600519', name: '贵州茅台', price: 1 },
          { code: '300', name: 'A', price: 22 },
        ],
        schema as readonly typeof schema[number][],
      ),
    );
    const lines = out.split('\n');
    // All non-separator lines should have the same visual width
    const w = (l: string): number => Array.from(l).reduce((a, ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      const isWide =
        (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xff00 && cp <= 0xff60);
      return a + (isWide ? 2 : 1);
    }, 0);
    expect(w(lines[0]!)).toBe(w(lines[2]!));
    expect(w(lines[2]!)).toBe(w(lines[3]!));
  });

  it('truncates long cells with …', () => {
    const out = stripAnsi(
      renderTable<Row>(
        [{ code: 'VERYLONGCODE', name: 'longname超出', price: 1 }],
        schema as readonly typeof schema[number][],
      ),
    );
    expect(out).toContain('…');
  });

  it('honors highlightRow with inverse ANSI', () => {
    const out = renderTable<Row>(
      [{ code: '1', name: 'x', price: 1 }],
      schema as readonly typeof schema[number][],
      { highlightRow: 0 },
    );
    expect(out).toContain('\x1b[7m');
  });
});
