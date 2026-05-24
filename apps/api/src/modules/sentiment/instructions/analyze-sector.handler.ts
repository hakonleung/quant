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
  AnalyzeSectorArgsSchema,
  errResult,
  instructionId,
  marketSentimentLines,
  okResult,
  QuantError,
  type InstructionResult,
  type MarketSentiment,
} from '@quant/shared';
import type { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { SectorsService } from '../../sectors/sectors.service.js';
import { NewsSentimentService } from '../news-sentiment.service.js';

const MAX_SECTOR_CODES = 50;

const argsSchema = AnalyzeSectorArgsSchema;
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
    imAliases: ['板块舆情', '板块分析', '舆情板块'],
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
          market: 'a',
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
  const briefBlock = m.brief.length > 0 ? `\n\n${m.brief}` : '';
  const detail = marketSentimentLines(m).join('\n');
  return `${head}${briefBlock}\n\n${detail}`;
}
