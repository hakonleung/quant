import { describe, expect, it } from 'vitest';
import { selectableList } from '../widgets/selectable-list.js';
import { stripAnsi } from '../render/ansi.js';
import type { CommitResolution, KeySpec } from '../widgets/types.js';

interface Row {
  readonly id?: string;
  readonly code: string;
  readonly name: string;
  readonly [k: string]: unknown;
}

const items: readonly Row[] = [
  { code: '600519', name: '贵州茅台' },
  { code: '000001', name: '平安银行' },
  { code: '600036', name: '招商银行' },
];

const widget = selectableList<Row>({
  title: 'pick',
  items,
  columns: [
    { key: 'code', header: 'CODE', max: 8 },
    { key: 'name', header: 'NAME', max: 14 },
  ],
  onCommit: (s) => ({ kind: 'command', line: `info ${s.code}` }),
  extraKeys: [
    {
      key: 'a',
      hint: { keys: ['a'], label: 'analyze', danger: true },
      resolve: (s) => ({ kind: 'command', line: `analyze ${s.code}` }),
    },
  ],
});

const k = (special?: string, text?: string): KeySpec =>
  text === undefined ? { special: special as never } : { text };

describe('selectableList — navigation', () => {
  it('Down moves cursor by one (golden)', () => {
    const step = widget.handleKey(widget.initialState, k('Down'));
    expect(step.kind).toBe('state');
    if (step.kind === 'state') expect(step.next.idx).toBe(1);
  });
  it('Up clamps at 0', () => {
    const step = widget.handleKey(widget.initialState, k('Up'));
    expect(step.kind).toBe('state');
    if (step.kind === 'state') expect(step.next.idx).toBe(0);
  });
  it('End jumps to last', () => {
    const step = widget.handleKey(widget.initialState, k('End'));
    expect(step.kind).toBe('state');
    if (step.kind === 'state') expect(step.next.idx).toBe(2);
  });
});

describe('selectableList — Enter / commit', () => {
  it('Enter on default selection commits with onCommit result (golden)', () => {
    const step = widget.handleKey(widget.initialState, k('Enter'));
    expect(step.kind).toBe('submit');
    if (step.kind === 'submit') {
      const r = step.result as CommitResolution;
      expect(r).toEqual({ kind: 'command', line: 'info 600519' });
    }
  });
  it('Enter on empty list returns state', () => {
    const empty = selectableList<Row>({
      title: 't',
      items: [],
      columns: [{ key: 'code', header: 'CODE' }],
    });
    const step = empty.handleKey(empty.initialState, k('Enter'));
    expect(step.kind).toBe('state');
  });
});

describe('selectableList — extraKeys', () => {
  it('"a" shortcut commits via extraKey resolver', () => {
    const step = widget.handleKey(widget.initialState, k(undefined, 'a'));
    expect(step.kind).toBe('submit');
    if (step.kind === 'submit') {
      const r = step.result as CommitResolution;
      expect(r).toEqual({ kind: 'command', line: 'analyze 600519' });
    }
  });
});

describe('selectableList — filter', () => {
  it('"/" enters filter mode and narrows on text', () => {
    let s = widget.initialState;
    let step = widget.handleKey(s, k(undefined, '/'));
    expect(step.kind).toBe('state');
    if (step.kind === 'state') s = step.next;
    expect(s.inFilter).toBe(true);

    step = widget.handleKey(s, k(undefined, '茅'));
    if (step.kind === 'state') s = step.next;
    expect(s.visible.length).toBe(1);
    expect(s.visible[0]?.code).toBe('600519');
  });
  it('Backspace in filter shrinks query', () => {
    let s = widget.initialState;
    let step = widget.handleKey(s, k(undefined, '/'));
    if (step.kind === 'state') s = step.next;
    step = widget.handleKey(s, k(undefined, '银'));
    if (step.kind === 'state') s = step.next;
    expect(s.visible.length).toBe(2);
    step = widget.handleKey(s, k('Backspace'));
    if (step.kind === 'state') s = step.next;
    expect(s.visible.length).toBe(items.length);
  });
  it('Enter exits filter mode', () => {
    let s = widget.initialState;
    let step = widget.handleKey(s, k(undefined, '/'));
    if (step.kind === 'state') s = step.next;
    step = widget.handleKey(s, k('Enter'));
    if (step.kind === 'state') s = step.next;
    expect(s.inFilter).toBe(false);
  });
});

describe('selectableList — viewport windowing', () => {
  const many: readonly Row[] = Array.from({ length: 25 }, (_, i) => ({
    code: String(600000 + i).padStart(6, '0'),
    name: `名${String(i)}`,
  }));
  const w = selectableList<Row>({
    title: 'big',
    items: many,
    viewportRows: 10,
    columns: [{ key: 'code', header: 'CODE', max: 8 }],
    onCommit: (s) => ({ kind: 'command', line: `info ${s.code}` }),
  });

  it('initial state shows scroll=0 with full first page', () => {
    expect(w.initialState.scroll).toBe(0);
  });

  it('Down beyond viewport advances scroll', () => {
    let s = w.initialState;
    for (let i = 0; i < 12; i += 1) {
      const step = w.handleKey(s, { special: 'Down' as never });
      if (step.kind === 'state') s = step.next;
    }
    expect(s.idx).toBe(12);
    expect(s.scroll).toBeGreaterThanOrEqual(3);
    expect(s.idx).toBeLessThan(s.scroll + 10);
  });

  it('End jumps to last with scroll positioned', () => {
    const step = w.handleKey(w.initialState, { special: 'End' as never });
    expect(step.kind).toBe('state');
    if (step.kind === 'state') {
      expect(step.next.idx).toBe(24);
      expect(step.next.scroll).toBe(15);
    }
  });

  it('PageDown advances by 10 with scroll', () => {
    const step = w.handleKey(w.initialState, { special: 'PageDown' as never });
    expect(step.kind).toBe('state');
    if (step.kind === 'state') {
      expect(step.next.idx).toBe(10);
      expect(step.next.scroll).toBe(1);
    }
  });

  it('rendered output includes ↑ / ↓ pagination indicator', () => {
    let s = w.initialState;
    const step = w.handleKey(s, { special: 'End' as never });
    if (step.kind === 'state') s = step.next;
    const out = stripAnsi(w.render(s, 60));
    expect(out).toContain('25/25');
  });
});

describe('selectableList — render', () => {
  it('renders title and table', () => {
    const out = stripAnsi(widget.render(widget.initialState, 60));
    expect(out).toContain('pick');
    expect(out).toContain('CODE');
    expect(out).toContain('600519');
  });
  it('renders empty state hint', () => {
    const empty = selectableList<Row>({
      title: 't',
      items: [],
      columns: [{ key: 'code', header: 'CODE' }],
      emptyHint: 'nothing here',
    });
    const out = stripAnsi(empty.render(empty.initialState, 40));
    expect(out).toContain('nothing here');
  });
});
