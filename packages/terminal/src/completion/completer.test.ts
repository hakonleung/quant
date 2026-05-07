import { describe, expect, it } from 'vitest';
import { complete } from '../completion/completer.js';

const env = {
  commands: ['stock', 'sector', 'analyze', 'help'],
  subcommands: { stock: ['find', 'info', 'kline'], sector: ['list', 'show', 'add'] },
  paramCompleter: (cmd: string, idx: number, frag: string) => {
    if (cmd === 'analyze' && idx === 0) {
      return [{ insert: '600519', label: '600519 贵州茅台' }];
    }
    return frag === '' ? [] : [{ insert: `${frag}xxx`, label: `${frag}xxx` }];
  },
};

describe('completer', () => {
  it('completes top-level command (golden)', () => {
    const r = complete('st', 2, env);
    expect(r.candidates.map((c) => c.insert)).toEqual(['stock']);
  });

  it('lists all commands when fragment is empty', () => {
    const r = complete('', 0, env);
    expect(r.candidates.length).toBe(env.commands.length);
  });

  it('completes subcommand after command name', () => {
    const r = complete('stock ', 6, env);
    expect(r.candidates.map((c) => c.insert)).toEqual(['find', 'info', 'kline']);
  });

  it('routes to paramCompleter for positional arg', () => {
    const r = complete('analyze ', 8, env);
    expect(r.candidates).toEqual([{ insert: '600519', label: '600519 贵州茅台' }]);
  });

  it('returns common prefix for multi-match', () => {
    const r = complete('s', 1, env);
    expect(r.commonPrefix).toBe('s');
  });

  it('tokenStart points to start of active fragment', () => {
    const r = complete('analyze 60', 10, env);
    expect(r.tokenStart).toBe(8);
    expect(r.tokenEnd).toBe(10);
  });
});
