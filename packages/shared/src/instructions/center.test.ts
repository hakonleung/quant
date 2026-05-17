/**
 * Tests for the InstructionCenter foundation. Covers:
 *   - type-level parity: ArgsOf / ResultOf derive from the manifest
 *   - invoke() round-trip
 *   - dispatch() golden path + every failure mode → envelope
 *   - coerceArgs() validation
 *   - alias / dotted subcommand resolution
 *   - Excluded ids: config type drops them, has() returns false at runtime
 *   - tokenize() golden + error paths (re-exposed from shared)
 */

import { describe, expect, it } from 'vitest';

import {
  ArgvParseError,
  InstructionCenter,
  InstructionDispatchError,
  coerceArgs,
  parseArgv,
  tokenize,
  type ArgsOf,
  type InstructionConfig,
  type InstructionEnvelope,
  type ResultOf,
} from './index.js';

// ── tokenize ────────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('splits bare positional args on whitespace', () => {
    expect(tokenize('a b  c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps quoted segments together', () => {
    expect(tokenize('"hello world" foo')).toEqual(['hello world', 'foo']);
    expect(tokenize("'a b c'")).toEqual(['a b c']);
  });

  it('honours backslash escapes outside quotes', () => {
    expect(tokenize('foo\\ bar baz')).toEqual(['foo bar', 'baz']);
  });

  it('treats double-quoted backslash as a literal next char', () => {
    expect(tokenize('"a\\"b"')).toEqual(['a"b']);
  });

  it('returns empty list on empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('throws ArgvParseError on unterminated quote', () => {
    expect(() => tokenize('"oops')).toThrow(ArgvParseError);
    expect(() => tokenize("'oops")).toThrow(ArgvParseError);
  });
});

describe('parseArgv', () => {
  it('separates positional args from --key=value flags', () => {
    const r = parseArgv(['x', '--k=v', 'y']);
    expect(r.positional).toEqual(['x', 'y']);
    expect(r.flags).toEqual({ k: 'v' });
  });

  it('consumes the next token for --key value', () => {
    const r = parseArgv(['--k', 'v', 'rest']);
    expect(r.positional).toEqual(['rest']);
    expect(r.flags).toEqual({ k: 'v' });
  });

  it('treats trailing --flag and back-to-back --flag --flag2 as booleans', () => {
    const r = parseArgv(['--a', '--b', 'c']);
    expect(r.flags).toEqual({ a: true, b: 'c' });
    const r2 = parseArgv(['--a']);
    expect(r2.flags).toEqual({ a: true });
  });

  it('ends flag parsing at bare --', () => {
    const r = parseArgv(['--a=1', '--', '--b']);
    expect(r.positional).toEqual(['--b']);
    expect(r.flags).toEqual({ a: '1' });
  });

  it('treats bare key=value tokens as flags (no leading --)', () => {
    const r = parseArgv(['300632', 'code=300632', 'fresh=1']);
    expect(r.positional).toEqual(['300632']);
    expect(r.flags).toEqual({ code: '300632', fresh: '1' });
  });

  it('keeps tokens whose key portion is not a valid identifier as positional', () => {
    const r = parseArgv(['=foo', '1=2', 'x y=z', 'has space=v']);
    // `=foo` empty key → positional; `1=2` key starts with digit → positional;
    // 'x y=z' / 'has space=v' arrived as a single token via a quoted source
    // → positional (key contains space).
    expect(r.positional).toEqual(['=foo', '1=2', 'x y=z', 'has space=v']);
    expect(r.flags).toEqual({});
  });
});

// ── coerceArgs ──────────────────────────────────────────────────────────

describe('coerceArgs', () => {
  it('validates and returns the typed args object', () => {
    // `stock` manifest entry has `q?: string, limit: number (default 10)`.
    const args = coerceArgs('stock', { positional: [], flags: { q: 'maotai', limit: '5' } });
    expect(args).toEqual({ q: 'maotai', limit: 5 });
  });

  it('applies schema defaults when flags are absent', () => {
    const args = coerceArgs('stock', { positional: [], flags: {} });
    expect(args).toEqual({ limit: 10 });
  });

  it('throws InstructionDispatchError(validation) on bad input', () => {
    expect(() =>
      coerceArgs('stock', { positional: [], flags: { limit: 'not-a-number' } }),
    ).toThrow(InstructionDispatchError);
  });

  it('throws InstructionDispatchError(not-found) on unknown id', () => {
    // Cast through unknown — this is intentionally an unknown id at runtime.
    expect(() =>
      coerceArgs('does.not.exist' as unknown as 'stock', { positional: [], flags: {} }),
    ).toThrow(/unknown instruction/);
  });
});

// ── InstructionCenter (typed mock cells) ────────────────────────────────

interface FakeEnv {
  ctx: { calls: string[] };
  host: { log: string[] };
  output: { rendered: string };
}

function usrCell(): InstructionConfig<FakeEnv, never>['usr'] {
  return {
    async handler(_args: ArgsOf<'usr'>, ctx) {
      ctx.calls.push('usr.handler');
      const result: ResultOf<'usr'> = {
        identity: { userId: 'u1', role: 'admin', source: 'test' },
        ledger: null,
      };
      return result;
    },
    renderer(env: InstructionEnvelope<ResultOf<'usr'>>, host) {
      if (env.ok) {
        host.log.push('ok');
        return { rendered: `usr:${env.data.identity.userId}` };
      }
      host.log.push('err');
      return { rendered: `err:${env.error.code}:${env.error.message}` };
    },
  };
}

// Helper to construct a minimal center that only knows the `usr` id.
// We exclude every other manifest id so the config type accepts a
// single-cell map. Listing them is tedious but explicit — exactly the
// "user declares what they don't support" contract.
type AllButUsr = Exclude<keyof import('./manifest.js').ManifestById & string, 'usr'>;

function makeUsrOnlyCenter(): InstructionCenter<FakeEnv, AllButUsr> {
  return new InstructionCenter<FakeEnv, AllButUsr>({ usr: usrCell() });
}

describe('InstructionCenter', () => {
  it('invoke() calls the handler and returns its typed result', async () => {
    const c = makeUsrOnlyCenter();
    const ctx: FakeEnv['ctx'] = { calls: [] };
    const r = await c.invoke('usr', {}, ctx);
    expect(r.identity.userId).toBe('u1');
    expect(ctx.calls).toEqual(['usr.handler']);
  });

  it('render() runs the renderer for proactive (non-dispatch) flows', () => {
    const c = makeUsrOnlyCenter();
    const host: FakeEnv['host'] = { log: [] };
    const env: InstructionEnvelope<ResultOf<'usr'>> = {
      ok: true,
      data: { identity: { userId: 'u9', role: 'user', source: 'cron' }, ledger: null },
    };
    const out = c.render('usr', env, host);
    expect(out.rendered).toBe('usr:u9');
    expect(host.log).toEqual(['ok']);
  });

  it('dispatch() golden path: tokenize → handler → renderer', async () => {
    const c = makeUsrOnlyCenter();
    const ctx: FakeEnv['ctx'] = { calls: [] };
    const host: FakeEnv['host'] = { log: [] };
    const out = await c.dispatch('usr', ctx, host);
    expect(out.rendered).toBe('usr:u1');
    expect(host.log).toEqual(['ok']);
  });

  it('dispatch() routes args-validation failures into the renderer as an envelope', async () => {
    // We need an instruction whose schema rejects something. `stock`
    // requires `limit` to coerce to a number ≥ 1 — give it junk.
    const cell = {
      async handler(_args: ArgsOf<'stock'>) {
        throw new Error('should not be called');
      },
      renderer(env: InstructionEnvelope<ResultOf<'stock'>>, host: FakeEnv['host']) {
        if (env.ok) return { rendered: 'ok' };
        host.log.push(env.error.code);
        return { rendered: `err:${env.error.code}` };
      },
    };
    type AllButStock = Exclude<keyof import('./manifest.js').ManifestById & string, 'stock'>;
    const c = new InstructionCenter<FakeEnv, AllButStock>({ stock: cell });
    const ctx: FakeEnv['ctx'] = { calls: [] };
    const host: FakeEnv['host'] = { log: [] };
    const out = await c.dispatch('stock --limit=not-a-number', ctx, host);
    expect(out.rendered).toBe('err:validation');
    expect(host.log).toEqual(['validation']);
  });

  it('dispatch() catches handler throws and renders as error envelope', async () => {
    const cell: InstructionConfig<FakeEnv, AllButUsr>['usr'] = {
      async handler() {
        throw new Error('boom');
      },
      renderer(env, host) {
        if (env.ok) return { rendered: 'ok' };
        host.log.push('caught');
        return { rendered: `err:${env.error.code}:${env.error.message}` };
      },
    };
    const c = new InstructionCenter<FakeEnv, AllButUsr>({ usr: cell });
    const ctx: FakeEnv['ctx'] = { calls: [] };
    const host: FakeEnv['host'] = { log: [] };
    const out = await c.dispatch('usr', ctx, host);
    expect(out.rendered).toBe('err:handler:boom');
    expect(host.log).toEqual(['caught']);
  });

  it('dispatch() uses fallbackRenderer when the id itself is unknown', async () => {
    const c = makeUsrOnlyCenter();
    const ctx: FakeEnv['ctx'] = { calls: [] };
    const host: FakeEnv['host'] = { log: [] };
    const out = await c.dispatch('unknown.cmd', ctx, host, {
      fallbackRenderer: (e) => ({ rendered: `fallback:${e.code}` }),
    });
    expect(out.rendered).toBe('fallback:not-found');
  });

  it('dispatch() re-throws when id is unknown and no fallback is provided', async () => {
    const c = makeUsrOnlyCenter();
    await expect(c.dispatch('unknown.cmd', { calls: [] }, { log: [] })).rejects.toThrow(
      InstructionDispatchError,
    );
  });

  it('dispatch() honours requireSlashPrefix=true', async () => {
    const c = new InstructionCenter<FakeEnv, AllButUsr>(
      { usr: usrCell() },
      { requireSlashPrefix: true },
    );
    const ctx: FakeEnv['ctx'] = { calls: [] };
    const host: FakeEnv['host'] = { log: [] };
    const out = await c.dispatch('/usr', ctx, host);
    expect(out.rendered).toBe('usr:u1');
    // Bare `usr` (no slash) → parse error in this mode.
    const errOut = await c.dispatch('usr', ctx, host, {
      fallbackRenderer: (e) => ({ rendered: e.code }),
    });
    expect(errOut.rendered).toBe('parse');
  });

  it('dispatch() resolves dotted subcommands (sector show → sector.show)', async () => {
    const stub = {
      async handler() {
        return {
          id: 's1',
          name: 'tech',
          kind: 'user',
          createdBy: 'me',
          isOwn: true,
          published: false,
          totalCount: 0,
          codes: [],
          stockRows: null,
          evidenceKeys: [],
          evidenceByCode: {},
        } as ResultOf<'sector.show'>;
      },
      renderer(env: InstructionEnvelope<ResultOf<'sector.show'>>) {
        return { rendered: env.ok ? 'show' : `err:${env.error.code}` };
      },
    };
    type AllButSectorShow = Exclude<
      keyof import('./manifest.js').ManifestById & string,
      'sector.show'
    >;
    const c = new InstructionCenter<FakeEnv, AllButSectorShow>({ 'sector.show': stub });
    // Positional binding is phase-2 work: today coerceArgs reads flags
    // only (the existing manifest schemas only describe flags). So pass
    // `id` as a flag and assert dotted-subcommand resolution still wins.
    const out = await c.dispatch('sector show --id=s1', { calls: [] }, { log: [] });
    expect(out.rendered).toBe('show');
  });

  it('dispatch() resolves IM aliases (Chinese) when the id is configured', async () => {
    const c = makeUsrOnlyCenter();
    const out = await c.dispatch('我的', { calls: [] }, { log: [] });
    expect(out.rendered).toBe('usr:u1');
  });

  it('ids() and has() reflect the post-Excluded configured set', () => {
    const c = makeUsrOnlyCenter();
    expect(c.ids()).toEqual(['usr']);
    expect(c.has('usr')).toBe(true);
    expect(c.has('stock')).toBe(false);
  });

  it('dispatch() rejects an instruction id that exists in the manifest but is excluded here', async () => {
    const c = makeUsrOnlyCenter();
    // `stock` is in the manifest but not configured on this center → fallback to error.
    const out = await c.dispatch('stock', { calls: [] }, { log: [] }, {
      fallbackRenderer: (e) => ({ rendered: e.code }),
    });
    expect(out.rendered).toBe('not-found');
  });

  it('dispatch() rejects empty input', async () => {
    const c = makeUsrOnlyCenter();
    const out = await c.dispatch('   ', { calls: [] }, { log: [] }, {
      fallbackRenderer: (e) => ({ rendered: e.code }),
    });
    expect(out.rendered).toBe('parse');
  });
});

// ── compile-time parity demo (no runtime assertion) ─────────────────────

describe('type-level parity', () => {
  it('forces FE and BE configs to declare the same id set (minus their Excluded)', () => {
    // FE excludes BE-only ids; BE excludes FE-only ids; both must
    // provide a cell for `usr`. The configs below intentionally model
    // that — TS rejects this file at compile time if either side
    // forgets `usr`. The runtime check below just confirms execution.
    type FeExcluded =
      | 'help'
      | 'ping'
      | 'sector.show'
      | 'sector.publish'
      | 'sector.unpublish'
      | 'sector.refresh'
      | 'sector.rm'
      | 'watch.add'
      | 'watch.remove'
      | 'watch.group'
      | 'analyze.sector'
      | 'ta.sector'
      | 'ledger.analyze'
      | 'agent.confirm'
      | 'web.search'
      | 'channel.echo'
      | 'channel.send';
    type FeMinusBeOnly = Exclude<
      keyof import('./manifest.js').ManifestById & string,
      FeExcluded | 'usr'
    >;
    type FeAllExceptUsr = FeMinusBeOnly;
    // We don't actually build the whole FE center here (that's app code).
    // Just demonstrate the type compiles when usr is provided alongside
    // the rest excluded.
    const _proof: InstructionConfig<FakeEnv, FeAllExceptUsr | FeExcluded> = {
      usr: usrCell(),
    };
    expect(Object.keys(_proof)).toEqual(['usr']);
  });
});
