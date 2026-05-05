import { describe, expect, it } from 'vitest';
import { confirmPrompt } from '../widgets/confirm-prompt.js';
import { stripAnsi } from '../render/ansi.js';
import type { CommitResolution, KeySpec } from '../widgets/types.js';

const k = (special?: string, text?: string): KeySpec =>
  text === undefined ? { special: special as never } : { text };

const yesRes: CommitResolution = { kind: 'command', line: 'do' };
const noRes: CommitResolution = { kind: 'output', entry: { body: 'cancelled', status: 'info' } };

describe('confirmPrompt — defaults', () => {
  it('non-danger defaults to YES selection (golden)', () => {
    const w = confirmPrompt({ title: 't', onYes: () => yesRes });
    expect(w.initialState.selectedYes).toBe(true);
  });
  it('danger=true defaults to NO selection', () => {
    const w = confirmPrompt({ title: 't', danger: true, onYes: () => yesRes });
    expect(w.initialState.selectedYes).toBe(false);
  });
});

describe('confirmPrompt — keyboard', () => {
  const w = confirmPrompt({
    title: 't',
    danger: true,
    onYes: () => yesRes,
    onNo: () => noRes,
  });

  it('y submits with onYes resolution', () => {
    const step = w.handleKey(w.initialState, k(undefined, 'y'));
    expect(step.kind).toBe('submit');
    if (step.kind === 'submit') expect(step.result).toEqual(yesRes);
  });
  it('n submits with onNo resolution', () => {
    const step = w.handleKey(w.initialState, k(undefined, 'n'));
    expect(step.kind).toBe('submit');
    if (step.kind === 'submit') expect(step.result).toEqual(noRes);
  });
  it('Left toggles selection', () => {
    const step = w.handleKey(w.initialState, k('Left'));
    expect(step.kind).toBe('state');
    if (step.kind === 'state') expect(step.next.selectedYes).toBe(true);
  });
  it('Enter on default-N (danger) submits onNo', () => {
    const step = w.handleKey(w.initialState, k('Enter'));
    expect(step.kind).toBe('submit');
    if (step.kind === 'submit') expect(step.result).toEqual(noRes);
  });
});

describe('confirmPrompt — render', () => {
  it('renders title with body and YES/NO labels', () => {
    const w = confirmPrompt({ title: 'sure?', body: 'paid op', onYes: () => yesRes });
    const out = stripAnsi(w.render(w.initialState, 60));
    expect(out).toContain('sure?');
    expect(out).toContain('paid op');
    expect(out).toContain('YES');
    expect(out).toContain('NO');
  });
});
