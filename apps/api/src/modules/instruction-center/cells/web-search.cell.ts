/**
 * `/web.search` cell — hosted-tool web search via the Qwen provider
 * (DashScope `enable_search`). Provider is intentionally locked to
 * `qwen` because it's the only provider in the catalog with a
 * `webSearchKind`; Moonshot's tool-loop is heavier/pricier and we
 * don't want silent drift if QWEN_API_KEY is unset.
 *
 * Handler returns `{ text }` — the LLM-produced summary. No peek
 * hook: every call is a paid LLM round-trip.
 */

import {
  okResult,
  type InstructionCell,
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import { LlmService } from '../../llm/llm.service.js';
import type { BeEnv, ImOutput } from '../be-types.js';

type WebSearchResult = ResultOf<'web.search'>;

export interface WebSearchCellDeps {
  readonly llm: LlmService;
}

export function buildWebSearchCell(
  deps: WebSearchCellDeps,
): InstructionCell<BeEnv, 'web.search'> {
  return {
    async handler(args, ctx): Promise<WebSearchResult> {
      const result = await deps.llm.completeWithWebSearch(
        {
          system: `你是一个网络搜索助手。用户给你一个查询，你搜索并提炼最多 ${String(args.n)} 条最相关的结果，每条包含来源标题和摘要。用中文回复。`,
          user: args.q,
        },
        { userId: ctx.userId, traceId: ctx.traceId, scope: 'agent' },
        { scope: 'agent', needWebSearch: true, provider: 'qwen' },
      );
      return { text: result.text };
    },
    renderer(envelope) {
      return renderWebSearch(envelope);
    },
  };
}

export function renderWebSearch(envelope: InstructionEnvelope<WebSearchResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  return okResult(envelope.data.text);
}
