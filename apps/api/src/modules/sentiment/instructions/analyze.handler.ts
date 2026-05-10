/**
 * `/analyze <code>` — single-stock sentiment via the news pipeline.
 *
 * Aligns the IM surface with the term widget's `analyze.one` action so
 * a Feishu user gets the same view the terminal renders. Output is the
 * verbatim analyst write-up (`Sentiment.result`) plus the structured
 * score/theme/driver line — short enough to fit one card.
 *
 * `/analyze.sector <id>` is the matching sector handler (see
 * `analyze-sector.handler.ts`); the term equivalent is `analyze.many`.
 *
 * Async + costsCredits: the per-stock pass invokes the web-search
 * analyst step + JSON aggregator (5–15 s typical paid call).
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  okResult,
  QuantError,
  type InstructionResult,
  type Sentiment,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { NewsSentimentService } from '../news-sentiment.service.js';

const truthy = new Set(['1', 'true', 'yes']);

const argsSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/u, 'expected 6-digit code'),
    fresh: z
      .union([z.string(), z.boolean()])
      .optional()
      .transform((v) => {
        if (v === undefined) return false;
        if (typeof v === 'boolean') return v;
        return truthy.has(v.toLowerCase());
      }),
    windowDays: z.coerce.number().int().min(1).max(30).optional(),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

@Injectable()
export class AnalyzeInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('analyze'),
    summary:
      'Run news sentiment analysis for one A-share (paid). analyze <code> [fresh=1] [windowDays=N]',
    summaryCn: '舆情分析（单只股票，对齐 term 的 analyze.one）',
    group: 'market',
    argsSchema,
    positional: ['code'],
    imAliases: ['舆情', '分析'],
    mode: 'async',
    costsCredits: true,
    examples: ['analyze 600519', 'analyze 600519 windowDays=7'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(NewsSentimentService) private readonly sentiment: NewsSentimentService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    let result: Sentiment;
    try {
      result = await this.sentiment.analyzeOne(
        {
          code: args.code,
          ...(args.fresh ? { bypassCache: true } : {}),
          ...(args.windowDays !== undefined ? { windowDays: args.windowDays } : {}),
        },
        { userId: ctx.userId, traceId: ctx.traceId },
      );
    } catch (err) {
      if (err instanceof QuantError) return errResult('handler', err.message);
      throw err;
    }
    return okResult(formatSentiment(result));
  }
}

export function formatSentiment(s: Sentiment): string {
  const score = s.score.toFixed(2);
  const head = [
    `${s.code}  score=${score}  target=${s.target.toFixed(2)}  asof=${s.cachedAt.slice(0, 10)}`,
    `主题: ${s.theme}`,
    `驱动: ${s.driver}`,
    s.rumor.length > 0 ? `传闻: ${s.rumor}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
  const body = s.result.trim();
  if (body.length === 0) return head;
  // Cap the analyst write-up — Feishu cards have a 3000-char body limit
  // and the full LLM output can be long. Tail truncated rather than
  // head so the user sees the most recent / strongest signals.
  const MAX_BODY = 1600;
  const trimmed =
    body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n…(truncated)` : body;
  return `${head}\n\n${trimmed}`;
}
