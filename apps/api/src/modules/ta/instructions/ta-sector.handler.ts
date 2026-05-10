/**
 * `/ta sector <id>` — sector-level technical-analysis fan-out + LLM
 * narrative summary. Aligns the IM surface with the term widget's
 * `analyze.ta.many` action so a Feishu user can ask for the same view
 * the terminal panel renders.
 *
 * Flow:
 *   1. Resolve the sector by id / name via `SectorsService.resolveVisible`
 *      (own + published).
 *   2. Hand the member codes off to `TaService.analyzeSector` — that
 *      method does per-stock fan-out (cache-first), then asks the LLM
 *      to narrate the aggregate.
 *
 * Async + costsCredits because the per-stock pass triggers TA LLM calls
 * for any cold members and the sector summary is one extra paid call.
 * The agent / IM confirm flow already gates `costsCredits` instructions
 * so the user sees the confirm card before any LLM round-trip.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  okResult,
  QuantError,
  type InstructionResult,
  type TaSectorAnalysis,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { SectorsService } from '../../sectors/sectors.service.js';
import { TaService } from '../ta.service.js';

const MAX_SECTOR_CODES = 50;

const boolFlag = z
  .enum(['0', '1', 'true', 'false'])
  .default('0')
  .transform((v) => v === '1' || v === 'true');

const argsSchema = z
  .object({
    id: z.string().min(1).describe('Sector id (e.g. s1) or sector name'),
    fresh: boolFlag.describe('Bypass per-stock TA cache and re-run every member'),
    confirm: boolFlag.optional().describe('IM paid-confirm token, set by the card button'),
  })
  .strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class TaSectorInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('ta.sector'),
    summary:
      'Run TA fan-out + LLM summary for every member of a sector (paid). ta.sector <id> [fresh=1]',
    summaryCn: '板块技术分析：成员逐只 + 板块整体趋势综述（LLM）',
    group: 'market',
    mode: 'async',
    costsCredits: true,
    requiresImConfirm: true,
    argsSchema,
    positional: ['id'],
    imAliases: ['板块技术', '板块走势', '板块技分'],
    examples: ['ta.sector s1', 'ta.sector s1 fresh=1'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(TaService) private readonly ta: TaService,
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
        `sector ${sector.id} has ${String(sector.codes.length)} codes; max ${String(MAX_SECTOR_CODES)} per /ta.sector call`,
      );
    }
    let analysis: TaSectorAnalysis;
    try {
      analysis = await this.ta.analyzeSector({
        codes: sector.codes,
        label: sector.name,
        bypassCache: args.fresh,
        ctx: { userId: ctx.userId, traceId: ctx.traceId },
      });
    } catch (err) {
      if (err instanceof QuantError) return errResult('handler', err.message);
      throw err;
    }
    return okResult(formatSectorAnalysis(sector.id, sector.name, analysis));
  }
}

const DIR_LABEL: Readonly<Record<'up' | 'down' | 'sideways', string>> = {
  up: '↑ 多头',
  down: '↓ 空头',
  sideways: '→ 震荡',
};

export function formatSectorAnalysis(
  sectorId: string,
  sectorName: string,
  a: TaSectorAnalysis,
): string {
  const conf = (a.overallConfidence * 100).toFixed(0);
  const head = [
    `${sectorId}  ${sectorName}  members=${String(a.members.length)}`,
    `整体: ${DIR_LABEL[a.overallDirection]}  置信度=${conf}%  (↑${String(a.trendBreakdown.up)} / ↓${String(a.trendBreakdown.down)} / →${String(a.trendBreakdown.sideways)})`,
  ].join('\n');
  const summary = a.summary.trim().length > 0 ? `\n\n${a.summary.trim()}` : '';
  const caveats = a.caveats.length > 0 ? `\n\n⚠ caveats: ${a.caveats.join('; ')}` : '';
  return `${head}${summary}${caveats}`;
}
