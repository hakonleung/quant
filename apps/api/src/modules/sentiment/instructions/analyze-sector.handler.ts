/**
 * `/analyze.sector <id>` — sector-level news sentiment fan-out + LLM
 * theme cluster + market-trend synth.
 *
 * Aligns the IM surface with the term widget's `analyze.many` action:
 * resolves a sector by id/name, fans `NewsSentimentService.analyzeOne`
 * across every member, then asks the LLM to cluster themes + synthesise
 * an aggregate market view. Counterpart to `/ta.sector` (TA-side).
 *
 * Async + costsCredits because each cold member triggers a paid web-search
 * pass and the cluster + synth step is one extra paid call.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  okResult,
  QuantError,
  type InstructionResult,
  type MarketSentiment,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { SectorsService } from '../../sectors/sectors.service.js';
import { NewsSentimentService } from '../news-sentiment.service.js';

const truthy = new Set(['1', 'true', 'yes']);
const MAX_SECTOR_CODES = 50;

const argsSchema = z
  .object({
    id: z.string().min(1).describe('Sector id (e.g. s1) or sector name'),
    fresh: z
      .union([z.string(), z.boolean()])
      .optional()
      .transform((v) => {
        if (v === undefined) return false;
        if (typeof v === 'boolean') return v;
        return truthy.has(v.toLowerCase());
      }),
    windowDays: z.coerce.number().int().min(1).max(30).optional(),
    confirm: z
      .union([z.string(), z.boolean()])
      .optional()
      .transform((v) => {
        if (v === undefined) return false;
        if (typeof v === 'boolean') return v;
        return truthy.has(v.toLowerCase());
      })
      .describe('IM paid-confirm token, set by the card button'),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

@Injectable()
export class AnalyzeSectorInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('analyze.sector'),
    summary:
      'Run sentiment fan-out + LLM theme cluster for every member of a sector (paid). analyze.sector <id> [fresh=1]',
    summaryCn: '舆情板块分析（对齐 term 的 analyze.many）：成员逐只 + 主题聚类 + 趋势综述',
    group: 'market',
    argsSchema,
    positional: ['id'],
    mode: 'async',
    costsCredits: true,
    requiresImConfirm: true,
    examples: ['analyze.sector s1', 'analyze.sector s1 fresh=1'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(NewsSentimentService) private readonly sentiment: NewsSentimentService,
    @Inject(SectorsService) private readonly sectors: SectorsService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    let sector;
    try {
      sector = this.sectors.resolveVisible(ctx.userId, args.id);
    } catch (err) {
      if (err instanceof QuantError && err.code === 'NOT_FOUND') {
        return errResult('not-found', err.message);
      }
      throw err;
    }
    if (sector.codes.length === 0) {
      return errResult('validation', `sector ${sector.id} has no member codes`);
    }
    if (sector.codes.length > MAX_SECTOR_CODES) {
      return errResult(
        'validation',
        `sector ${sector.id} has ${String(sector.codes.length)} codes; max ${String(MAX_SECTOR_CODES)} per /analyze.sector call`,
      );
    }
    let result: MarketSentiment;
    try {
      result = await this.sentiment.analyzeMany(
        {
          codes: sector.codes,
          ...(args.fresh ? { bypassCache: true } : {}),
          ...(args.windowDays !== undefined ? { windowDays: args.windowDays } : {}),
        },
        { userId: ctx.userId, traceId: ctx.traceId },
      );
    } catch (err) {
      if (err instanceof QuantError) return errResult('handler', err.message);
      throw err;
    }
    return okResult(formatMarketSentiment(sector.id, sector.name, result));
  }
}

export function formatMarketSentiment(
  sectorId: string,
  sectorName: string,
  m: MarketSentiment,
): string {
  const head = `${sectorId}  ${sectorName}  members=${String(m.codes.length)}  asof=${m.asof}  window=${String(m.windowDays)}d`;
  const themes = m.themeClusters
    .map((c, i) => {
      const heat = c.heatScore.toFixed(2);
      return `  ${String(i + 1)}. [${c.label}] heat=${heat}  ${c.summary}  (${String(c.memberCount)} 只)`;
    })
    .join('\n');
  const themeBlock = themes.length > 0 ? `\n\n主题聚类:\n${themes}` : '';
  const summary =
    m.marketTrendSummary.trim().length > 0 ? `\n\n${m.marketTrendSummary.trim()}` : '';
  const caveats = m.caveats.length > 0 ? `\n\n⚠ caveats: ${m.caveats.join('; ')}` : '';
  return `${head}${themeBlock}${summary}${caveats}`;
}
