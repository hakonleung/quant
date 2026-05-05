import { describe, expect, it } from 'vitest';
import { pasteText } from '../widgets/paste-text.js';
import type { CommitResolution, KeySpec } from '../widgets/types.js';

const k = (special?: string, text?: string): KeySpec =>
  text === undefined ? { special: special as never } : { text };

describe('pasteText', () => {
  const w = pasteText({
    title: 't',
    onSubmit: (text): CommitResolution => ({ kind: 'output', entry: { body: text, status: 'ok' } }),
  });

  it('typed chars accumulate (golden)', () => {
    let s = w.initialState;
    for (const ch of 'a"b') {
      const step = w.handleKey(s, k(undefined, ch));
      if (step.kind === 'state') s = step.next;
    }
    expect(s.buffer).toBe('a"b');
  });

  it('Enter inserts newline', () => {
    let s = w.initialState;
    const step1 = w.handleKey(s, k('Enter'));
    if (step1.kind === 'state') s = step1.next;
    expect(s.buffer).toBe('\n');
  });

  it('Backspace at cursor 0 is no-op (boundary)', () => {
    const step = w.handleKey(w.initialState, k('Backspace'));
    expect(step.kind).toBe('state');
    if (step.kind === 'state') expect(step.next.buffer).toBe('');
  });

  it('Ctrl+Enter submits with current buffer', () => {
    let s = w.initialState;
    for (const ch of 'xyz') {
      const step = w.handleKey(s, k(undefined, ch));
      if (step.kind === 'state') s = step.next;
    }
    const step = w.handleKey(s, k('CtrlEnter'));
    expect(step.kind).toBe('submit');
    if (step.kind === 'submit') {
      const r = step.result;
      expect(r).toEqual({ kind: 'output', entry: { body: 'xyz', status: 'ok' } });
    }
  });

  it('paste of multi-line chunk inserts as one block', () => {
    const step = w.handleKey(w.initialState, k(undefined, 'line1\nline2'));
    expect(step.kind).toBe('state');
    if (step.kind === 'state') expect(step.next.buffer).toBe('line1\nline2');
  });
});
