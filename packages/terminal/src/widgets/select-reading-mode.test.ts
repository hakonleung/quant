import { describe, expect, it, vi } from 'vitest';

import { selectReadingMode } from './select-reading-mode.js';

describe('select-reading-mode widget', () => {
  it('starts highlighting brief (idx 0)', () => {
    const w = selectReadingMode({ title: 't', onPick: () => ({ kind: 'noop' }) });
    expect(w.initialState.idx).toBe(0);
  });

  it('arrow keys move between brief and detail', () => {
    const w = selectReadingMode({ title: 't', onPick: () => ({ kind: 'noop' }) });
    const down = w.handleKey(w.initialState, { special: 'Down' });
    expect(down.kind).toBe('state');
    if (down.kind !== 'state') return;
    expect(down.next.idx).toBe(1);
    const up = w.handleKey(down.next, { special: 'Up' });
    if (up.kind !== 'state') throw new Error('unreachable');
    expect(up.next.idx).toBe(0);
  });

  it('Enter submits the highlighted mode', () => {
    const onPick = vi.fn(() => ({ kind: 'noop' as const }));
    const w = selectReadingMode({ title: 't', onPick });
    // start at brief → Enter
    let r = w.handleKey(w.initialState, { special: 'Enter' });
    expect(r.kind).toBe('submit');
    expect(onPick).toHaveBeenLastCalledWith('brief');
    // move to detail → Enter
    const down = w.handleKey(w.initialState, { special: 'Down' });
    if (down.kind !== 'state') throw new Error('unreachable');
    r = w.handleKey(down.next, { special: 'Enter' });
    expect(r.kind).toBe('submit');
    expect(onPick).toHaveBeenLastCalledWith('detail');
  });

  it('b / d hot-keys submit directly without arrow navigation', () => {
    const onPick = vi.fn(() => ({ kind: 'noop' as const }));
    const w = selectReadingMode({ title: 't', onPick });
    const rb = w.handleKey(w.initialState, { text: 'b' });
    expect(rb.kind).toBe('submit');
    expect(onPick).toHaveBeenLastCalledWith('brief');
    const rd = w.handleKey(w.initialState, { text: 'd' });
    expect(rd.kind).toBe('submit');
    expect(onPick).toHaveBeenLastCalledWith('detail');
  });

  it('case-insensitive hot-keys (B/D)', () => {
    const onPick = vi.fn(() => ({ kind: 'noop' as const }));
    const w = selectReadingMode({ title: 't', onPick });
    w.handleKey(w.initialState, { text: 'B' });
    expect(onPick).toHaveBeenLastCalledWith('brief');
    w.handleKey(w.initialState, { text: 'D' });
    expect(onPick).toHaveBeenLastCalledWith('detail');
  });

  it('snapshot includes the selected mode', () => {
    const w = selectReadingMode({ title: 'analyze 600519', onPick: () => ({ kind: 'noop' }) });
    expect(w.snapshot(w.initialState)).toBe('analyze 600519 → brief');
    expect(w.snapshot({ idx: 1 })).toBe('analyze 600519 → detail');
  });
});
