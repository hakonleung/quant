import { describe, expect, it } from 'vitest';

import { parseTrailingCursorUp } from './parse-trailing-cursor-up.js';

describe('parseTrailingCursorUp', () => {
  it('returns 0 when the string ends with a printable', () => {
    expect(parseTrailingCursorUp('hello world')).toBe(0);
  });

  it('returns 0 for an empty string', () => {
    expect(parseTrailingCursorUp('')).toBe(0);
  });

  it('counts a single trailing F (cursor previous line)', () => {
    expect(parseTrailingCursorUp('body\x1b[6F')).toBe(6);
  });

  it('counts A as up and B as down', () => {
    expect(parseTrailingCursorUp('body\x1b[3A')).toBe(3);
    expect(parseTrailingCursorUp('body\x1b[3B')).toBe(0); // clamped to 0
  });

  it('treats a bare F (no number) as 1 row up', () => {
    expect(parseTrailingCursorUp('body\x1b[F')).toBe(1);
  });

  it('ignores trailing column move (\\x1b[<n>G) but tallies the F before it', () => {
    // form-prompt's typical "place caret" tail.
    expect(parseTrailingCursorUp('body\x1b[6F\x1b[16G')).toBe(6);
  });

  it('strips DEC private mode show/hide cursor but tallies the F before it', () => {
    expect(parseTrailingCursorUp('body\x1b[?25h\x1b[6F\x1b[16G')).toBe(6);
    expect(parseTrailingCursorUp('body\x1b[?25l')).toBe(0);
  });

  it('strips a bare trailing carriage return', () => {
    expect(parseTrailingCursorUp('body\r')).toBe(0);
    // \r before a CSI move keeps the move counted.
    expect(parseTrailingCursorUp('body\x1b[2A\r')).toBe(2);
  });

  it('does not count cursor escapes embedded mid-string', () => {
    // The colour run \x1b[2A here is followed by a printable "x" — it's
    // NOT trailing, so it should be ignored.
    expect(parseTrailingCursorUp('body\x1b[2Ax')).toBe(0);
  });

  it('handles the form-prompt cursor-escape composition', () => {
    // Real form-prompt tail: \x1b[?25h then up N rows then absolute col.
    // The bug in the previous walk-back implementation returned 0 here
    // because the trailing letter "G" matched `>= 0x20` and short-circuited
    // the cutoff loop, leaving the tail empty.
    expect(parseTrailingCursorUp('field\x1b[?25h\x1b[5F\x1b[16G')).toBe(5);
  });

  it('chains multiple trailing row moves', () => {
    expect(parseTrailingCursorUp('body\x1b[2A\x1b[3F')).toBe(5);
  });

  it('returns 0 when the down moves outweigh up moves', () => {
    expect(parseTrailingCursorUp('body\x1b[2A\x1b[5B')).toBe(0);
  });
});
