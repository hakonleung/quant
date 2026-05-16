/**
 * Tests for the /analyze cell — handler + renderer + peek (IM confirm
 * bypass) for the first migrated async + paid-confirm instruction.
 *
 * Handler covers:
 *   - golden path returns the upstream Sentiment verbatim
 *   - fresh=true forwards bypassCache=true; absent windowDays omitted
 *   - windowDays forwarded when present
 *   - QuantError throws propagate (executor wraps to error envelope)
 *   - non-QuantError throws propagate (async job logger sees them)
 *
 * Renderer covers:
 *   - score / target / asof / theme / driver formatting
 *   - 传闻 line emitted only when rumor non-empty
 *   - head-only output when result body is empty
 *   - no handler-side truncation
 *   - error envelope passthrough
 *
 * Peek covers:
 *   - cached hit → true (skip confirm card)
 *   - fresh=true always falls through to gate → false
 *   - cache miss → false
 *   - getCachedStock throw → false (fail closed)
 *   - invalid args → false
 *   - default windowDays = 30 forwarded on miss
 */

import {
  QuantError,
  type InstructionEnvelope,
  type ResultOf,
  type Sentiment,
} from '@quant/shared';

import { buildAnalyzeCell } from '../../../src/modules/instruction-center/cells/analyze.cell.js';
import {
  formatSentiment,
  renderAnalyze,
} from '../../../src/modules/instruction-center/cells/analyze.render.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type { NewsSentimentService } from '../../../src/modules/sentiment/news-sentiment.service.js';

type AnalyzeResult = ResultOf<'analyze'>;

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'feishu:ou_a' };

const baseSentiment: Sentiment = {
  code: '600519',
  score: 0.82,
  theme: '白酒旺季提价预期',
  driver: '春节前备货需求',
  target: 1800.0,
  rumor: '',
  cachedAt: '2026-05-06T10:00:00.000+00:00',
  rawLog: [],
  result: '贵州茅台近期消费旺盛，机构普遍上调目标价。',
};

interface FakeSentimentOpts {
  readonly resolve?: Sentiment;
  readonly reject?: Error;
  readonly cached?: Sentiment | null;
  readonly cachedThrows?: boolean;
}

interface AnalyzeOneCall {
  request: { code: string; bypassCache?: boolean; windowDays?: number };
  userMeta: { userId: string; traceId: string };
}

function fakeSentiment(opts: FakeSentimentOpts = {}): {
  service: NewsSentimentService;
  analyzeCalls: AnalyzeOneCall[];
  cachedCalls: { code: string; windowDays: number }[];
} {
  const analyzeCalls: AnalyzeOneCall[] = [];
  const cachedCalls: { code: string; windowDays: number }[] = [];
  const service = {
    analyzeOne: (request: AnalyzeOneCall['request'], userMeta: AnalyzeOneCall['userMeta']) => {
      analyzeCalls.push({ request, userMeta });
      if (opts.reject !== undefined) return Promise.reject(opts.reject);
      return Promise.resolve(opts.resolve ?? baseSentiment);
    },
    getCachedStock: (code: string, windowDays: number) => {
      cachedCalls.push({ code, windowDays });
      if (opts.cachedThrows === true) return Promise.reject(new Error('cache down'));
      return Promise.resolve(opts.cached ?? null);
    },
  } as unknown as NewsSentimentService;
  return { service, analyzeCalls, cachedCalls };
}

describe('buildAnalyzeCell.handler', () => {
  it('returns the upstream Sentiment verbatim', async () => {
    const { service } = fakeSentiment();
    const cell = buildAnalyzeCell({ sentiment: service });
    const r = await cell.handler({ code: '600519', fresh: false, confirm: false }, ctx);
    expect(r).toEqual(baseSentiment);
  });

  it('forwards bypassCache=true when fresh=true; omits windowDays when absent', async () => {
    const { service, analyzeCalls } = fakeSentiment();
    const cell = buildAnalyzeCell({ sentiment: service });
    await cell.handler({ code: '600519', fresh: true, confirm: false }, ctx);
    expect(analyzeCalls[0]?.request).toEqual({ code: '600519', bypassCache: true });
  });

  it('forwards windowDays when present and omits bypassCache when fresh=false', async () => {
    const { service, analyzeCalls } = fakeSentiment();
    const cell = buildAnalyzeCell({ sentiment: service });
    await cell.handler({ code: '600519', fresh: false, confirm: false, windowDays: 7 }, ctx);
    expect(analyzeCalls[0]?.request).toEqual({ code: '600519', windowDays: 7 });
  });

  it('propagates QuantError so the executor wraps to error envelope', async () => {
    const { service } = fakeSentiment({
      reject: new QuantError('LLM_FAILED', 'llm quota exceeded', {}),
    });
    const cell = buildAnalyzeCell({ sentiment: service });
    await expect(
      cell.handler({ code: '600519', fresh: false, confirm: false }, ctx),
    ).rejects.toBeInstanceOf(QuantError);
  });

  it('propagates non-QuantError throws (for the async-job logger)', async () => {
    const { service } = fakeSentiment({ reject: new Error('net error') });
    const cell = buildAnalyzeCell({ sentiment: service });
    await expect(
      cell.handler({ code: '600519', fresh: false, confirm: false }, ctx),
    ).rejects.toThrow('net error');
  });
});

describe('renderAnalyze', () => {
  function okEnv(s: Sentiment): InstructionEnvelope<AnalyzeResult> {
    return { ok: true, data: s };
  }

  it('renders score / target / asof / theme / driver in the head', () => {
    const out = renderAnalyze(okEnv(baseSentiment));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('600519');
    expect(out.output.text).toContain('score=0.82');
    expect(out.output.text).toContain('target=1800.00');
    expect(out.output.text).toContain('asof=2026-05-06');
    expect(out.output.text).toContain('主题: 白酒旺季提价预期');
    expect(out.output.text).toContain('驱动: 春节前备货需求');
  });

  it('passes through error envelope verbatim', () => {
    const out = renderAnalyze({ ok: false, error: { code: 'handler', message: 'llm down' } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toEqual({ code: 'handler', message: 'llm down' });
  });

  it('does not truncate long results (analyst prompt caps body upstream)', () => {
    const long = 'X'.repeat(2000);
    const out = renderAnalyze(okEnv({ ...baseSentiment, result: long }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).not.toContain('…(truncated)');
    expect(out.output.text).toContain(long);
  });

  describe('formatSentiment', () => {
    it('omits 传闻 line when rumor is empty', () => {
      expect(formatSentiment({ ...baseSentiment, rumor: '' })).not.toContain('传闻:');
    });

    it('includes 传闻 line when rumor is non-empty', () => {
      expect(formatSentiment({ ...baseSentiment, rumor: '董事长辞职传言' })).toContain(
        '传闻: 董事长辞职传言',
      );
    });

    it('returns head only when result body is empty', () => {
      expect(formatSentiment({ ...baseSentiment, result: '' })).not.toContain('\n\n');
    });
  });
});

describe('buildAnalyzeCell.peek (IM confirm bypass)', () => {
  it('returns true when cache hit + fresh=false → skip confirm card', async () => {
    const { service, cachedCalls } = fakeSentiment({ cached: baseSentiment });
    const cell = buildAnalyzeCell({ sentiment: service });
    expect(cell.peek).toBeDefined();
    const bypass = await cell.peek!({ code: '600519', fresh: false }, ctx);
    expect(bypass).toBe(true);
    expect(cachedCalls[0]).toEqual({ code: '600519', windowDays: 30 });
  });

  it('returns false when fresh=true (user explicitly asked for re-run)', async () => {
    const { service, cachedCalls } = fakeSentiment({ cached: baseSentiment });
    const cell = buildAnalyzeCell({ sentiment: service });
    const bypass = await cell.peek!({ code: '600519', fresh: true }, ctx);
    expect(bypass).toBe(false);
    expect(cachedCalls).toHaveLength(0);
  });

  it('returns false on cache miss', async () => {
    const { service } = fakeSentiment({ cached: null });
    const cell = buildAnalyzeCell({ sentiment: service });
    const bypass = await cell.peek!({ code: '600519', fresh: false }, ctx);
    expect(bypass).toBe(false);
  });

  it('returns false (fail closed) when getCachedStock throws', async () => {
    const { service } = fakeSentiment({ cachedThrows: true });
    const cell = buildAnalyzeCell({ sentiment: service });
    const bypass = await cell.peek!({ code: '600519', fresh: false }, ctx);
    expect(bypass).toBe(false);
  });

  it('returns false on invalid args (zod parse fails)', async () => {
    const { service } = fakeSentiment({ cached: baseSentiment });
    const cell = buildAnalyzeCell({ sentiment: service });
    const bypass = await cell.peek!({ code: 'invalid-non-digit' }, ctx);
    expect(bypass).toBe(false);
  });

  it('forwards an explicit windowDays from rawArgs to the cache probe', async () => {
    const { service, cachedCalls } = fakeSentiment({ cached: baseSentiment });
    const cell = buildAnalyzeCell({ sentiment: service });
    await cell.peek!({ code: '600519', fresh: false, windowDays: 7 }, ctx);
    expect(cachedCalls[0]).toEqual({ code: '600519', windowDays: 7 });
  });
});
