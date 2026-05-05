import { describe, expect, it } from 'vitest';
import { padEnd, padStart, truncate, visualWidth } from '../render/width.js';
import { ANSI, paint } from '../render/ansi.js';

describe('width', () => {
  describe('visualWidth', () => {
    it('returns column count for ASCII (golden)', () => {
      expect(visualWidth('hello')).toBe(5);
    });
    it('counts CJK as 2 columns', () => {
      expect(visualWidth('贵州茅台')).toBe(8);
    });
    it('mixes ASCII and CJK', () => {
      expect(visualWidth('600519 贵州茅台')).toBe(6 + 1 + 8);
    });
    it('strips ANSI before counting', () => {
      expect(visualWidth(paint('abc', ANSI.red))).toBe(3);
    });
    it('returns 0 for empty string (boundary)', () => {
      expect(visualWidth('')).toBe(0);
    });
    it('treats control chars as 0 width', () => {
      expect(visualWidth('\x07ab')).toBe(2);
    });
  });

  describe('padEnd / padStart', () => {
    it('pads ASCII to right', () => {
      expect(padEnd('abc', 5)).toBe('abc  ');
    });
    it('pads CJK by visual width, not codepoints', () => {
      expect(padEnd('茅台', 6)).toBe('茅台  ');
    });
    it('returns input unchanged when wider than target', () => {
      expect(padEnd('abcdef', 3)).toBe('abcdef');
    });
    it('left-pads numbers', () => {
      expect(padStart('42', 5)).toBe('   42');
    });
  });

  describe('truncate', () => {
    it('returns input when within max', () => {
      expect(truncate('abc', 5)).toBe('abc');
    });
    it('truncates ASCII with …', () => {
      expect(truncate('abcdef', 4)).toBe('abc…');
    });
    it('truncates CJK respecting width', () => {
      // "贵州茅台" = 8 cols; max=5 → fit only 贵州 (4) + … (1) = 5
      expect(truncate('贵州茅台', 5)).toBe('贵州…');
    });
    it('returns ellipsis for max=1 (boundary)', () => {
      expect(truncate('abcdef', 1)).toBe('…');
    });
    it('returns empty when max <= 0 (boundary)', () => {
      expect(truncate('abc', 0)).toBe('');
    });
  });
});
