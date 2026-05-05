import { describe, expect, it } from 'vitest';
import {
  ArgvParseError,
  parseArgv,
  parseLine,
  tokenize,
} from '../engine/parse-argv.js';

describe('tokenize', () => {
  it('splits on whitespace (golden)', () => {
    expect(tokenize('a b  c')).toEqual(['a', 'b', 'c']);
  });
  it('returns [] for empty input (boundary)', () => {
    expect(tokenize('')).toEqual([]);
  });
  it('returns [] for whitespace only', () => {
    expect(tokenize('   ')).toEqual([]);
  });
  it('keeps double-quoted phrase as one token', () => {
    expect(tokenize('analyze "hello world"')).toEqual(['analyze', 'hello world']);
  });
  it('keeps single-quoted phrase as one token (no escape)', () => {
    expect(tokenize("sector add '近 60 日 涨停'")).toEqual(['sector', 'add', '近 60 日 涨停']);
  });
  it('handles backslash escape outside quotes', () => {
    expect(tokenize('a b\\ c')).toEqual(['a', 'b c']);
  });
  it('handles empty quoted string', () => {
    expect(tokenize('cmd ""')).toEqual(['cmd', '']);
  });
  it('throws ArgvParseError on unterminated quote', () => {
    expect(() => tokenize('cmd "abc')).toThrow(ArgvParseError);
  });
});

describe('parseArgv', () => {
  it('separates positional and key=value flags (golden)', () => {
    const r = parseArgv(['stock', 'find', '--limit=20', '茅台']);
    expect(r.positional).toEqual(['stock', 'find', '茅台']);
    expect(r.flags).toEqual({ limit: '20' });
  });
  it('treats --flag with following value as paired', () => {
    const r = parseArgv(['watch', 'add', '--market', 'a', '--code', '600519']);
    expect(r.positional).toEqual(['watch', 'add']);
    expect(r.flags).toEqual({ market: 'a', code: '600519' });
  });
  it('treats --flag at end as boolean true', () => {
    const r = parseArgv(['analyze', '600519', '--force']);
    expect(r.flags).toEqual({ force: true });
  });
  it('treats --flagA --flagB as both boolean', () => {
    const r = parseArgv(['cmd', '--a', '--b', 'x']);
    expect(r.flags).toEqual({ a: true, b: 'x' });
  });
  it('honors `--` end-of-flags marker', () => {
    const r = parseArgv(['cmd', '--', '--literal', 'arg']);
    expect(r.positional).toEqual(['cmd', '--literal', 'arg']);
    expect(r.flags).toEqual({});
  });
  it('returns empty result for empty input (boundary)', () => {
    expect(parseArgv([])).toEqual({ positional: [], flags: {} });
  });
});

describe('parseLine', () => {
  it('combines tokenize + parseArgv', () => {
    const r = parseLine('sector add --nl "近 60 日 3 次涨停" --name=动态测试');
    expect(r.positional).toEqual(['sector', 'add']);
    expect(r.flags).toEqual({ nl: '近 60 日 3 次涨停', name: '动态测试' });
  });
});
