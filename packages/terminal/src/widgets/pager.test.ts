import { describe, expect, it } from 'vitest';

import { pager } from './pager.js';

const SAMPLE = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota'].join(
  '\n',
);

describe('pager widget', () => {
  it('initial state shows the top of the document', () => {
    const w = pager({ title: 't', body: SAMPLE, viewportRows: 3 });
    expect(w.initialState.scroll).toBe(0);
    expect(w.initialState.lines).toHaveLength(9);
  });

  it('j scrolls down by one line, k scrolls up', () => {
    const w = pager({ title: 't', body: SAMPLE, viewportRows: 3 });
    const s1 = step(w.handleKey(w.initialState, { text: 'j' }));
    expect(s1.scroll).toBe(1);
    const s2 = step(w.handleKey(s1, { text: 'k' }));
    expect(s2.scroll).toBe(0);
    // k at top stays at 0
    const s3 = step(w.handleKey(s2, { text: 'k' }));
    expect(s3.scroll).toBe(0);
  });

  it('space scrolls a full viewport', () => {
    const w = pager({ title: 't', body: SAMPLE, viewportRows: 3 });
    const s1 = step(w.handleKey(w.initialState, { text: ' ' }));
    expect(s1.scroll).toBe(3);
    const s2 = step(w.handleKey(s1, { text: ' ' }));
    expect(s2.scroll).toBe(6);
    // viewport is 3, total is 9 → max scroll = 6; further space stays at 6
    const s3 = step(w.handleKey(s2, { text: ' ' }));
    expect(s3.scroll).toBe(6);
  });

  it('g jumps to top, G to bottom', () => {
    const w = pager({ title: 't', body: SAMPLE, viewportRows: 3 });
    const sBot = step(w.handleKey(w.initialState, { text: 'G' }));
    expect(sBot.scroll).toBe(6);
    const sTop = step(w.handleKey(sBot, { text: 'g' }));
    expect(sTop.scroll).toBe(0);
  });

  it('Home / End mirror g / G', () => {
    const w = pager({ title: 't', body: SAMPLE, viewportRows: 3 });
    const sEnd = step(w.handleKey(w.initialState, { special: 'End' }));
    expect(sEnd.scroll).toBe(6);
    const sHome = step(w.handleKey(sEnd, { special: 'Home' }));
    expect(sHome.scroll).toBe(0);
  });

  it('q closes via onClose resolution', () => {
    let closed = false;
    const w = pager({
      title: 't',
      body: SAMPLE,
      viewportRows: 3,
      onClose: () => {
        closed = true;
        return { kind: 'noop' };
      },
    });
    const r = w.handleKey(w.initialState, { text: 'q' });
    expect(r.kind).toBe('submit');
    if (r.kind === 'submit') {
      const resolution = (w.commit ?? ((x: unknown) => x))(r.result);
      expect(resolution).toEqual({ kind: 'noop' });
    }
    expect(closed).toBe(true);
  });

  it('Esc behaves like q (closes the pager)', () => {
    const w = pager({ title: 't', body: SAMPLE, viewportRows: 3 });
    const r = w.handleKey(w.initialState, { special: 'Escape' });
    expect(r.kind).toBe('submit');
  });

  it('search lifecycle: / enters search, types, Enter jumps to first match', () => {
    const w = pager({ title: 't', body: SAMPLE, viewportRows: 3 });
    const s1 = step(w.handleKey(w.initialState, { text: '/' }));
    expect(s1.inSearch).toBe(true);
    const s2 = step(w.handleKey(s1, { text: 'g' }));
    const s3 = step(w.handleKey(s2, { text: 'a' }));
    expect(s3.query).toBe('ga');
    const s4 = step(w.handleKey(s3, { special: 'Enter' }));
    expect(s4.inSearch).toBe(false);
    // 'gamma' is at index 2 → scroll moves to keep it visible
    expect(s4.matches).toContain(2);
    expect(s4.matchIdx).toBe(0);
  });

  it('n / N cycles through matches', () => {
    const w = pager({ title: 't', body: SAMPLE, viewportRows: 3 });
    let s = step(w.handleKey(w.initialState, { text: '/' }));
    s = step(w.handleKey(s, { text: 'e' }));
    s = step(w.handleKey(s, { special: 'Enter' }));
    // Matches contain at least: 'beta' (1), 'delta' (3), 'epsilon' (4), 'zeta' (5), 'eta' (6), 'theta' (7)
    expect(s.matches.length).toBeGreaterThan(1);
    const before = s.matchIdx;
    const nextStep = step(w.handleKey(s, { text: 'n' }));
    expect(nextStep.matchIdx).toBe((before + 1) % s.matches.length);
    const prevStep = step(w.handleKey(nextStep, { text: 'N' }));
    expect(prevStep.matchIdx).toBe(before);
  });

  it('search Escape clears the query and exits search mode', () => {
    const w = pager({ title: 't', body: SAMPLE, viewportRows: 3 });
    let s = step(w.handleKey(w.initialState, { text: '/' }));
    s = step(w.handleKey(s, { text: 'a' }));
    s = step(w.handleKey(s, { special: 'Escape' }));
    expect(s.inSearch).toBe(false);
    expect(s.query).toBe('');
    expect(s.matches).toEqual([]);
  });

  it('snapshot describes the document length', () => {
    const w = pager({ title: 'doc', body: SAMPLE });
    expect(w.snapshot(w.initialState)).toBe('doc (9 lines)');
  });
});

function step<S>(r: { kind: string; next?: S; result?: unknown }): S {
  if (r.kind !== 'state' || r.next === undefined) {
    throw new Error(`expected state step, got ${r.kind}`);
  }
  return r.next;
}
