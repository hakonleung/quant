import { instructionId } from '@quant/shared';

import { WebSearchInstructionHandler } from '../../../src/modules/agent/instructions/web-search.handler.js';
import type { LlmService } from '../../../src/modules/llm/llm.service.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't6', source: 'im', userId: 'feishu:ou_f' };

const llmResponse = {
  text: '贵州茅台近期出厂价上调，机构给出买入评级。',
  usage: { input: 100, output: 200, total: 300 },
  provider: 'qwen',
  model: 'qwen-turbo',
};

function build(opts: { resolve?: typeof llmResponse; reject?: Error }): {
  handler: WebSearchInstructionHandler;
  completeSpy: jest.MockedFunction<LlmService['completeWithWebSearch']>;
} {
  const reg = new InstructionRegistry();
  const completeSpy = jest.fn().mockImplementation(() => {
    if (opts.reject !== undefined) return Promise.reject(opts.reject);
    return Promise.resolve(opts.resolve ?? llmResponse);
  }) as jest.MockedFunction<LlmService['completeWithWebSearch']>;
  const llm: Pick<LlmService, 'completeWithWebSearch'> = { completeWithWebSearch: completeSpy };
  return {
    handler: new WebSearchInstructionHandler(reg, llm as unknown as LlmService),
    completeSpy,
  };
}

describe('WebSearchInstructionHandler', () => {
  it('declares spec id `web.search` with group=system and no mode (sync)', () => {
    const { handler } = build({ resolve: llmResponse });
    expect(handler.spec.id).toBe(instructionId('web.search'));
    expect(handler.spec.group).toBe('system');
    expect(handler.spec.mode).toBeUndefined();
  });

  it('golden path returns LLM text verbatim', async () => {
    const { handler } = build({ resolve: llmResponse });
    const r = await handler.execute({ q: '茅台出厂价', n: 5 }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toBe(llmResponse.text);
    }
  });

  it('pins provider=qwen and needWebSearch=true in opts arg', async () => {
    const { handler, completeSpy } = build({ resolve: llmResponse });
    await handler.execute({ q: 'A股市场', n: 3 }, ctx);
    const [, , opts] = completeSpy.mock.calls[0]!;
    expect(opts).toMatchObject({ provider: 'qwen', needWebSearch: true });
  });

  it('passes the user query as the `user` field in args', async () => {
    const { handler, completeSpy } = build({ resolve: llmResponse });
    await handler.execute({ q: '特定查询词', n: 5 }, ctx);
    const [args] = completeSpy.mock.calls[0]!;
    expect(args.user).toBe('特定查询词');
  });

  it('n parameter is reflected in the system prompt', async () => {
    const { handler, completeSpy } = build({ resolve: llmResponse });
    await handler.execute({ q: 'test', n: 7 }, ctx);
    const [args] = completeSpy.mock.calls[0]!;
    expect(args.system).toContain('7');
  });

  it('propagates LlmService errors without wrapping', async () => {
    const { handler } = build({ reject: new Error('qwen api key missing') });
    await expect(handler.execute({ q: 'test', n: 5 }, ctx)).rejects.toThrow('qwen api key missing');
  });

  it('costsCredits is not set (web search is system-level, not metered per the spec)', () => {
    const { handler } = build({ resolve: llmResponse });
    expect(handler.spec.costsCredits).toBeFalsy();
  });
});
