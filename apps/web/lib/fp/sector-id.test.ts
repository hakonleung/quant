import { describe, expect, it } from 'vitest';

import { makeSectorId } from './sector-id.js';

const fixedRng = (suffix: string): (() => string) => () => suffix;

describe('makeSectorId', () => {
  it('slugs ASCII titles to lowercase + dash and appends a 6-char suffix', () => {
    expect(makeSectorId('My Test Basket', fixedRng('abcdef'))).toBe('my-test-basket-abcdef');
  });

  it('keeps CJK characters in the slug and lowercases ASCII alongside', () => {
    expect(makeSectorId('白酒 Top10', fixedRng('zzzzzz'))).toBe('白酒-top10-zzzzzz');
  });

  it('strips leading + trailing dashes from the slug', () => {
    expect(makeSectorId('  ---hello---  ', fixedRng('xxxxxx'))).toBe('hello-xxxxxx');
  });

  it('truncates the slug to 24 chars before suffixing', () => {
    const long = 'a'.repeat(40);
    const id = makeSectorId(long, fixedRng('123456'));
    // 24 chars + dash + 6-char suffix = 31
    expect(id).toHaveLength(31);
    expect(id.startsWith('a'.repeat(24))).toBe(true);
    expect(id.endsWith('-123456')).toBe(true);
  });

  it('falls back to "sec" when the title contains no slug-able characters', () => {
    expect(makeSectorId('!!!', fixedRng('abcdef'))).toBe('sec-abcdef');
    expect(makeSectorId('', fixedRng('abcdef'))).toBe('sec-abcdef');
  });

  it('clamps the suffix to 6 chars even when the rng returns more', () => {
    expect(makeSectorId('x', fixedRng('abcdefghij'))).toBe('x-abcdef');
  });

  it('never returns the literal ALL_SECTOR_ID', () => {
    // The defensive `-x` shift in makeSectorId guards the synthetic
    // "全 A" sector's id from ever colliding with a freshly minted one.
    // Practically unreachable given base + dash + suffix concatenation,
    // but the check exists; this test pins the invariant.
    for (const name of ['', 'a', 'all', 'all sector', '——']) {
      expect(makeSectorId(name, () => 'sfxsfx')).not.toBe('all');
    }
  });
});
