/**
 * Tests for the /web.search cell — handler + renderer.
 *
 * Handler:
 *   - forwards `q` + `n` to LlmService.completeWithWebSearch
 *   - returns { text } from the LLM
 *   - provider locked to `qwen`, scope=`agent`, needWebSearch=true
 *   - propagates throws
 *
 * Renderer: emits the text verbatim; passes error envelope through.
 */

import type {
  InstructionEnvelope,
  ResultOf,
} from '@quant/shared';

import {
  buildWebSearchCell,
  renderWebSearch,
} from '../../../src/modules/instruction-center/cells/web-search.cell.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type { LlmService } from '../../../src/modules/llm/llm.service.js';

type WebSearchResult = ResultOf<'web.search'>;

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'me' };

interface SearchCall {
  prompt: { system: string; user: string };
  meta: { userId: string; traceId: string; scope: string };
  options: { scope: string; needWebSearch: boolean; provider: string };
}

function fakeLlm(opts: { resolveText?: string; reject?: Error }): {
  service: LlmService;
  calls: SearchCall[];
} {
  const calls: SearchCall[] = [];
  const service = {
    completeWithWebSearch: (
      prompt: SearchCall['prompt'],
      meta: SearchCall['meta'],
      options: SearchCall['options'],
    ) => {
      calls.push({ prompt, meta, options });
      if (opts.reject !== undefined) return Promise.reject(opts.reject);
      return Promise.resolve({ text: opts.resolveText ?? '搜索结果摘要' });
    },
  } as unknown as LlmService;
  return { service, calls };
}

describe('buildWebSearchCell.handler', () => {
  it('returns the LLM text wrapped in { text }', async () => {
    const cell = buildWebSearchCell({ llm: fakeLlm({}).service });
    const r = await cell.handler({ q: '今日新闻', n: 5 }, ctx);
    expect(r).toEqual<WebSearchResult>({ text: '搜索结果摘要' });
  });

  it('forwards q + n into the system prompt template', async () => {
    const { service, calls } = fakeLlm({});
    const cell = buildWebSearchCell({ llm: service });
    await cell.handler({ q: '茅台', n: 3 }, ctx);
    expect(calls[0]?.prompt.system).toContain('3');
    expect(calls[0]?.prompt.user).toBe('茅台');
  });

  it('locks provider to qwen + scope=agent + needWebSearch=true', async () => {
    const { service, calls } = fakeLlm({});
    const cell = buildWebSearchCell({ llm: service });
    await cell.handler({ q: 'x', n: 5 }, ctx);
    expect(calls[0]?.options).toEqual({
      scope: 'agent',
      needWebSearch: true,
      provider: 'qwen',
    });
  });

  it('forwards userId + traceId to the LLM call metadata', async () => {
    const { service, calls } = fakeLlm({});
    const cell = buildWebSearchCell({ llm: service });
    await cell.handler({ q: 'x', n: 5 }, ctx);
    expect(calls[0]?.meta).toEqual({
      userId: 'me',
      traceId: 't1',
      scope: 'agent',
    });
  });

  it('propagates throws from the LLM call', async () => {
    const cell = buildWebSearchCell({
      llm: fakeLlm({ reject: new Error('qwen api down') }).service,
    });
    await expect(cell.handler({ q: 'x', n: 5 }, ctx)).rejects.toThrow('qwen api down');
  });
});

describe('renderWebSearch', () => {
  function okEnv(text: string): InstructionEnvelope<WebSearchResult> {
    return { ok: true, data: { text } };
  }

  it('emits the text verbatim', () => {
    const out = renderWebSearch(okEnv('搜索结果'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('搜索结果');
  });

  it('passes through error envelope', () => {
    const out = renderWebSearch({
      ok: false,
      error: { code: 'handler', message: 'qwen down' },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toBe('qwen down');
  });
});
