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
  AnalyzeArgsSchema,
  errResult,
  instructionId,
  okResult,
  QuantError,
  type InstructionResult,
  type Sentiment,
} from '@quant/shared';
import type { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { NewsSentimentService } from '../news-sentiment.service.js';

const argsSchema = AnalyzeArgsSchema;
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
    requiresImConfirm: true,
    examples: ['analyze 600519', 'analyze 600519 windowDays=7'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(NewsSentimentService) private readonly sentiment: NewsSentimentService,
  ) {
    super(registry);
  }

  /**
   * IM paid-confirm bypass: served from cache for free? skip the gate.
   * `fresh=1` always falls through (the user explicitly asked for a
   * re-run, which is paid). Cache lookup mirrors `analyzeOne`'s key
   * (today's asof + windowDays).
   */
  async peekImConfirmBypass(
    rawArgs: Record<string, unknown>,
    _ctx: InstructionCtx,
  ): Promise<boolean> {
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) return false;
    if (parsed.data.fresh) return false;
    const windowDays = parsed.data.windowDays ?? 30;
    try {
      const cached = await this.sentiment.getCachedStock(parsed.data.code, windowDays);
      return cached !== null;
    } catch {
      return false;
    }
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
  // No handler-side truncation: the analyst prompt now caps output at
  // ≤1000 chars (`buildSentimentSearchSystem`), so head + body fits
  // well under Feishu's 3000-char card limit. Trusting the prompt is
  // simpler than re-trimming here and avoids the visible "…(truncated)"
  // suffix the user reported.
  return `${head}\n\n${body}`;
}
