/**
 * `web_search <q>` — run a web search via the Qwen provider's native
 * search augmentation (`enable_search: true`).  Exposed as an agent tool
 * so the model can answer questions about current events, recent news, or
 * anything outside the local data store.
 *
 * Provider is explicitly locked to `qwen` because Qwen's DashScope
 * endpoint is the only provider in the catalog with `webSearchKind`.
 * This is the *only* instruction handler that forces a provider — all
 * others use the default resolution in LlmService.
 */

import { Inject, Injectable } from '@nestjs/common';
import { instructionId, okResult, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { LlmService } from '../../llm/llm.service.js';

const argsSchema = z
  .object({
    q: z.string().min(1).max(500).describe('Search query — what to look up on the web'),
    n: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe('Max result summaries to return (default 5)'),
  })
  .strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class WebSearchInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('web.search'),
    summary: 'Search the web for current events or news. web.search q="..." [n=5]',
    summaryCn: '网络搜索（当前事件/新闻）',
    group: 'system',
    argsSchema,
    positional: ['q'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(LlmService) private readonly llm: LlmService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const result = await this.llm.completeWithWebSearch(
      {
        system: `你是一个网络搜索助手。用户给你一个查询，你搜索并提炼最多 ${String(args.n)} 条最相关的结果，每条包含来源标题和摘要。用中文回复。`,
        user: args.q,
      },
      { userId: ctx.userId, traceId: ctx.traceId, scope: 'agent' },
      // Lock provider to Qwen (DashScope `enable_search`) — Moonshot's
      // tool-loop is heavier and more expensive, and we don't want the
      // call to silently drift to it just because QWEN_API_KEY happens
      // to be unset on a given box. If qwen isn't configured the
      // resolver throws a clear "no API key set for provider qwen".
      { scope: 'agent', needWebSearch: true, provider: 'qwen' },
    );
    return okResult(result.text);
  }
}
