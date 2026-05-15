/**
 * `/screen` — kick off a natural-language screen from IM.
 *
 *   /screen "找昨日涨停今天回踩 ma5"
 *   /screen q="..." asof=2026-05-08
 *
 * Routes to `ScreenService.runNl` (Python `nl_screen` Flight op). LLM
 * translation + screen execution typically takes 5–15s, so the spec is
 * `mode: 'async'`: the IM listener acks immediately with a "queued"
 * card and pushes the matches once the worker finishes.
 *
 * Match table delegates to `StockListService.assembleRows({ kind: 'screen' })`.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  okResult,
  okResultWithMeta,
  QuantError,
  type InstructionResult,
  type NlScreenResult,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import {
  formatStockTable,
  stockTableMetaRows,
} from '../../stock-meta/domain/format-stock-table.js';
import { StockListService } from '../../stock-list/stock-list.service.js';
import { ScreenService } from '../screen.service.js';

const boolFlag = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) => {
    if (v === undefined) return false;
    if (typeof v === 'boolean') return v;
    const lower = v.toLowerCase();
    return lower === '1' || lower === 'true' || lower === 'yes';
  });

const argsSchema = z
  .object({
    q: z
      .string()
      .min(1)
      .max(500)
      .describe('Natural-language screening query in Chinese, e.g. "找昨日涨停今天回踩ma5"'),
    asof: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u, 'asof must be YYYY-MM-DD')
      .optional(),
    confirm: boolFlag.describe('IM paid-confirm token, set by the card button'),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

const MAX_MATCHES_DISPLAY = 30;

@Injectable()
export class ScreenInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('screen'),
    summary:
      'Run a natural-language screen via the LLM. `q="..."` (positional), `asof=YYYY-MM-DD`.',
    summaryCn: '自然语言选股，q="..." 描述筛选条件',
    group: 'market',
    argsSchema,
    positional: ['q'],
    imAliases: ['筛选', '选股'],
    mode: 'async',
    costsCredits: true,
    requiresImConfirm: true,
    examples: ['screen "市值大于100亿且年线上"', 'screen q="科技股 PE<30"'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(ScreenService) private readonly screen: ScreenService,
    @Inject(StockListService) private readonly stockList: StockListService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    let result: NlScreenResult;
    try {
      result = await this.screen.runNl(args.q, args.asof, {
        userId: ctx.userId,
        traceId: ctx.traceId,
      });
    } catch (err) {
      if (err instanceof QuantError) return errResult('handler', err.message);
      throw err;
    }
    const head = `screen "${result.nl}" asof=${result.asof}  matches=${String(result.matches.length)}`;
    if (result.matches.length === 0) {
      return okResult(`${head}\n  (no matches)`);
    }
    const codes = result.matches.slice(0, MAX_MATCHES_DISPLAY).map((m) => m.code);
    const tail =
      result.matches.length > MAX_MATCHES_DISPLAY
        ? `\n(+${String(result.matches.length - MAX_MATCHES_DISPLAY)} more)`
        : '';
    try {
      const out = await this.stockList.assembleRows({
        kind: 'screen',
        codes,
        traceId: ctx.traceId,
      });
      const text = `${head}\n\n${formatStockTable(out.rows)}${tail}`;
      return okResultWithMeta(text, {
        stockTableRows: stockTableMetaRows(out.rows),
        stockTableSubheader: `${head}${tail.length > 0 ? `  ·  ${tail.trim()}` : ''}`,
      });
    } catch {
      return okResult(`${head}\n\n${codes.join(', ')}${tail}`);
    }
  }
}
