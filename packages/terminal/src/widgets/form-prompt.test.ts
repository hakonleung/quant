import { describe, expect, it } from 'vitest';
import { formPrompt } from '../widgets/form-prompt.js';
import type { CommitResolution, KeySpec } from '../widgets/types.js';

const k = (special?: string, text?: string): KeySpec =>
  text === undefined ? { special: special as never } : { text };

describe('formPrompt — basic editing', () => {
  const w = formPrompt({
    title: 't',
    fields: [
      { key: 'name', label: 'name', kind: 'text' },
      { key: 'kind', label: 'kind', kind: 'enum', options: ['user', 'dynamic'], initial: 'user' },
    ],
    onSubmit: (v): CommitResolution => ({ kind: 'output', entry: { body: JSON.stringify(v), status: 'ok' } }),
  });

  it('typing into text field appends char (golden)', () => {
    let s = w.initialState;
    for (const ch of 'abc') {
      const step = w.handleKey(s, k(undefined, ch));
      if (step.kind === 'state') s = step.next;
    }
    expect(s.values['name']).toBe('abc');
  });

  it('Tab moves to next field; cycles around', () => {
    let s = w.initialState;
    let step = w.handleKey(s, k('Tab'));
    if (step.kind === 'state') s = step.next;
    expect(s.active).toBe(1);
    step = w.handleKey(s, k('Tab'));
    if (step.kind === 'state') s = step.next;
    expect(s.active).toBe(0);
  });

  it('Up/Down cycles enum values', () => {
    let s = w.initialState;
    let step = w.handleKey(s, k('Tab'));
    if (step.kind === 'state') s = step.next;
    step = w.handleKey(s, k('Down'));
    if (step.kind === 'state') s = step.next;
    expect(s.values['kind']).toBe('dynamic');
    step = w.handleKey(s, k('Down'));
    if (step.kind === 'state') s = step.next;
    expect(s.values['kind']).toBe('user');
  });

  it('Enter with required-empty field sets error, no submit', () => {
    let s = w.initialState;
    const step = w.handleKey(s, k('Enter'));
    expect(step.kind).toBe('state');
    if (step.kind === 'state') {
      s = step.next;
      expect(s.error).not.toBe(null);
    }
  });

  it('Enter with all required filled submits', () => {
    let s = w.initialState;
    for (const ch of 'foo') {
      const step = w.handleKey(s, k(undefined, ch));
      if (step.kind === 'state') s = step.next;
    }
    const step = w.handleKey(s, k('Enter'));
    expect(step.kind).toBe('submit');
  });
});

describe('formPrompt — validators', () => {
  const w = formPrompt({
    title: 't',
    fields: [
      {
        key: 'code',
        label: 'code',
        kind: 'text',
        validate: (v) => (/^\d{6}$/u.test(v) ? null : 'must be 6 digits'),
      },
    ],
    onSubmit: (): CommitResolution => ({ kind: 'noop' }),
  });
  it('rejects on validate error', () => {
    let s = w.initialState;
    for (const ch of '12') {
      const step = w.handleKey(s, k(undefined, ch));
      if (step.kind === 'state') s = step.next;
    }
    const step = w.handleKey(s, k('Enter'));
    expect(step.kind).toBe('state');
    if (step.kind === 'state') expect(step.next.error).toContain('6 digits');
  });
});
