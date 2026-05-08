import { ArgvParseError, parseArgvToObject, tokenize } from '../../../src/modules/instruction/parse-argv.js';

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('a  b\tc')).toEqual(['a', 'b', 'c']);
  });
  it('keeps quoted spaces together', () => {
    expect(tokenize('a "b c" d')).toEqual(['a', 'b c', 'd']);
  });
  it('honours backslash escapes inside quotes', () => {
    expect(tokenize('"a\\"b"')).toEqual(['a"b']);
  });
  it('throws on unterminated quote', () => {
    expect(() => tokenize('"abc')).toThrow(ArgvParseError);
  });
  it('returns empty list for blank', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('parseArgvToObject', () => {
  it('maps positionals in order', () => {
    expect(parseArgvToObject('600519', ['code'])).toEqual({ code: '600519' });
  });
  it('parses k=v pairs', () => {
    expect(parseArgvToObject('limit=20 preset=ma_break')).toEqual({
      limit: '20',
      preset: 'ma_break',
    });
  });
  it('mixes positional and k=v, k=v wins on conflict', () => {
    expect(parseArgvToObject('limit=20 600519', ['code', 'limit'])).toEqual({
      code: '600519',
      limit: '20',
    });
  });
  it('drops extra positionals beyond the declared list', () => {
    expect(parseArgvToObject('a b c', ['x'])).toEqual({ x: 'a' });
  });
  it('passes quoted values through verbatim', () => {
    expect(parseArgvToObject('text="hello world" target=u1', ['text'])).toEqual({
      text: 'hello world',
      target: 'u1',
    });
  });
  it('returns empty record for empty rest', () => {
    expect(parseArgvToObject('', ['code'])).toEqual({});
  });
});
