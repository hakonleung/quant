import { describe, expect, it } from 'vitest';
import { pickStockLoop, type StockLite } from '../widgets/pick-stock-loop.js';
import type { CommitResolution, KeySpec } from '../widgets/types.js';

const k = (special?: string, text?: string): KeySpec =>
  text === undefined ? { special: special as never } : { text };

const universe: readonly StockLite[] = [
  { code: '600519', name: '贵州茅台' },
  { code: '600036', name: '招商银行' },
  { code: '000001', name: '平安银行' },
];

const widget = pickStockLoop({
  title: 'pick',
  universe,
  onApply: (codes): CommitResolution => ({
    kind: 'output',
    entry: { body: codes.join(','), status: 'ok' },
  }),
});

describe('pickStockLoop', () => {
  it('typing narrows matches and Enter adds to basket', () => {
    let s = widget.initialState;
    for (const ch of '茅') {
      const step = widget.handleKey(s, k(undefined, ch));
      if (step.kind === 'state') s = step.next;
    }
    const step = widget.handleKey(s, k('Enter'));
    expect(step.kind).toBe('state');
    if (step.kind === 'state') {
      s = step.next;
      expect(s.basket).toEqual([{ code: '600519', name: '贵州茅台' }]);
      expect(s.query).toBe('');
    }
  });

  it('duplicate code is ignored on add', () => {
    let s = widget.initialState;
    let step = widget.handleKey(s, k(undefined, '茅'));
    if (step.kind === 'state') s = step.next;
    step = widget.handleKey(s, k('Enter'));
    if (step.kind === 'state') s = step.next;
    step = widget.handleKey(s, k(undefined, '茅'));
    if (step.kind === 'state') s = step.next;
    step = widget.handleKey(s, k('Enter'));
    if (step.kind === 'state') s = step.next;
    expect(s.basket.length).toBe(1);
  });

  it('Ctrl+D pops last from basket', () => {
    let s = widget.initialState;
    s = { ...s, basket: [universe[0]!, universe[1]!] };
    const step = widget.handleKey(s, k('CtrlD'));
    expect(step.kind).toBe('state');
    if (step.kind === 'state') expect(step.next.basket.length).toBe(1);
  });

  it('a applies non-empty basket', () => {
    const s = { ...widget.initialState, basket: [universe[0]!] };
    const step = widget.handleKey(s, k(undefined, 'a'));
    expect(step.kind).toBe('submit');
  });

  it('a on empty basket is no-op', () => {
    const step = widget.handleKey(widget.initialState, k(undefined, 'a'));
    expect(step.kind).toBe('state');
  });
});
