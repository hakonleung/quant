import { instructionId, QuantError, type Sentiment } from '@quant/shared';

import {
  AnalyzeInstructionHandler,
  formatSentiment,
} from '../../../src/modules/sentiment/instructions/analyze.handler.js';
import type { NewsSentimentService } from '../../../src/modules/sentiment/news-sentiment.service.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't4', source: 'im', userId: 'feishu:ou_d' };

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

function build(opts: { resolve?: Sentiment; reject?: Error }): {
  handler: AnalyzeInstructionHandler;
} {
  const reg = new InstructionRegistry();
  const sentiment: Pick<NewsSentimentService, 'analyzeOne'> = {
    analyzeOne: jest.fn().mockImplementation(() => {
      if (opts.reject !== undefined) return Promise.reject(opts.reject);
      if (opts.resolve === undefined) return Promise.reject(new Error('test misconfigured'));
      return Promise.resolve(opts.resolve);
    }),
  };
  return {
    handler: new AnalyzeInstructionHandler(
      reg,
      sentiment as unknown as NewsSentimentService,
    ),
  };
}

describe('AnalyzeInstructionHandler', () => {
  it('declares spec id `analyze` mode=async costsCredits=true with imAliases', () => {
    const { handler } = build({ resolve: baseSentiment });
    expect(handler.spec.id).toBe(instructionId('analyze'));
    expect(handler.spec.mode).toBe('async');
    expect(handler.spec.costsCredits).toBe(true);
    expect(handler.spec.imAliases).toEqual(['舆情', '分析']);
  });

  it('golden path renders score, target, 主题, 驱动', async () => {
    const { handler } = build({ resolve: baseSentiment });
    const r = await handler.execute({ code: '600519', fresh: false }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('600519');
      expect(r.output.text).toContain('score=0.82');
      expect(r.output.text).toContain('target=1800.00');
      expect(r.output.text).toContain('主题:');
      expect(r.output.text).toContain('驱动:');
    }
  });

  it('truncates body when result exceeds 1600 chars', async () => {
    const longResult = 'X'.repeat(2000);
    const { handler } = build({ resolve: { ...baseSentiment, result: longResult } });
    const r = await handler.execute({ code: '600519', fresh: false }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('…(truncated)');
    }
  });

  it('does not truncate when result is exactly 1600 chars', async () => {
    const exactResult = 'Y'.repeat(1600);
    const { handler } = build({ resolve: { ...baseSentiment, result: exactResult } });
    const r = await handler.execute({ code: '600519', fresh: false }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).not.toContain('…(truncated)');
    }
  });

  it('converts QuantError into errResult code=handler', async () => {
    const { handler } = build({
      reject: new QuantError('LLM_FAILED', 'llm quota exceeded', {}),
    });
    const r = await handler.execute({ code: '600519', fresh: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('handler');
      expect(r.error.message).toBe('llm quota exceeded');
    }
  });

  it('rethrows non-QuantError', async () => {
    const { handler } = build({ reject: new Error('net error') });
    await expect(handler.execute({ code: '600519', fresh: false }, ctx)).rejects.toThrow(
      'net error',
    );
  });

  describe('formatSentiment', () => {
    it('omits 传闻 line when rumor is empty', () => {
      const out = formatSentiment({ ...baseSentiment, rumor: '' });
      expect(out).not.toContain('传闻:');
    });

    it('includes 传闻 line when rumor is non-empty', () => {
      const out = formatSentiment({ ...baseSentiment, rumor: '董事长辞职传言' });
      expect(out).toContain('传闻: 董事长辞职传言');
    });

    it('returns only the head when result is empty', () => {
      const out = formatSentiment({ ...baseSentiment, result: '' });
      expect(out).not.toContain('\n\n');
    });
  });
});
