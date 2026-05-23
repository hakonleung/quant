import { describe, expect, it } from 'vitest';

import { isPrefixOf, normalizeEvent, parseSequence } from './parse-keys.js';

describe('parseSequence', () => {
  it('single letter → one token', () => {
    expect(parseSequence('a')).toEqual(['a']);
  });

  it('space-separated multi-token', () => {
    expect(parseSequence('g m')).toEqual(['g', 'm']);
  });

  it('canonicalizes shift+letter to uppercase', () => {
    expect(parseSequence('shift+d')).toEqual(['D']);
  });

  it('preserves uppercase shift form as-is', () => {
    expect(parseSequence('D')).toEqual(['D']);
  });

  it('preserves named keys', () => {
    expect(parseSequence('Esc')).toEqual(['Esc']);
    expect(parseSequence('Enter')).toEqual(['Enter']);
  });

  it('multi-token with mixed forms', () => {
    expect(parseSequence('z f')).toEqual(['z', 'f']);
  });

  it('empty / whitespace yields empty sequence', () => {
    expect(parseSequence('')).toEqual([]);
    expect(parseSequence('   ')).toEqual([]);
  });
});

describe('normalizeEvent', () => {
  function ev(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
    return new KeyboardEvent('keydown', init);
  }

  it('lowercase letter', () => {
    expect(normalizeEvent(ev({ key: 'a' }))).toBe('a');
  });

  it('shift+letter → uppercase', () => {
    expect(normalizeEvent(ev({ key: 'D', shiftKey: true }))).toBe('D');
  });

  it('Escape → Esc', () => {
    expect(normalizeEvent(ev({ key: 'Escape' }))).toBe('Esc');
  });

  it('Space → Space token', () => {
    expect(normalizeEvent(ev({ key: ' ' }))).toBe('Space');
  });

  it('Ctrl chord → null', () => {
    expect(normalizeEvent(ev({ key: 'a', ctrlKey: true }))).toBeNull();
  });

  it('Alt chord → null', () => {
    expect(normalizeEvent(ev({ key: 'a', altKey: true }))).toBeNull();
  });

  it('Meta chord → null', () => {
    expect(normalizeEvent(ev({ key: 'a', metaKey: true }))).toBeNull();
  });

  it('pure modifier keys ignored', () => {
    expect(normalizeEvent(ev({ key: 'Shift' }))).toBeNull();
    expect(normalizeEvent(ev({ key: 'Control' }))).toBeNull();
  });

  it('? passes through (Shift+/ on US layout)', () => {
    expect(normalizeEvent(ev({ key: '?', shiftKey: true }))).toBe('?');
  });
});

describe('isPrefixOf', () => {
  it('empty is prefix of anything', () => {
    expect(isPrefixOf([], ['a', 'b'])).toBe(true);
  });

  it('equal sequences are prefixes', () => {
    expect(isPrefixOf(['a', 'b'], ['a', 'b'])).toBe(true);
  });

  it('strict prefix', () => {
    expect(isPrefixOf(['g'], ['g', 'm'])).toBe(true);
  });

  it('mismatched token', () => {
    expect(isPrefixOf(['g', 'x'], ['g', 'm'])).toBe(false);
  });

  it('longer than target', () => {
    expect(isPrefixOf(['g', 'm', 'x'], ['g', 'm'])).toBe(false);
  });
});
