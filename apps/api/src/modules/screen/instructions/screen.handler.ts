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
 * v1 only exposes the NL entry point — `nl2dsl` and `run` would need
 * an AST input (impractical to type in IM); they remain HTTP-only.
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
  type StockSnapshotDto,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import {
  formatStockTable,
  stockTableMetaRows,
  type StockTableRow,
} from '../../stock-meta/domain/format-stock-table.js';
import { StockMetaService } from '../../stock-meta/stock-meta.service.js';
import { ScreenService } from '../screen.service.js';

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
    examples: ['screen "市值大于100亿且年线上"', 'screen q="科技股 PE<30"'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(ScreenService) private readonly screen: ScreenService,
    @Inject(StockMetaService) private readonly stockMeta: StockMetaService,
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
    let rows: StockTableRow[] | null = null;
    let table: string;
    try {
      const allSnapshots = await this.stockMeta.snapshotAll(ctx.traceId);
      const byCode = new Map<string, StockSnapshotDto>(allSnapshots.map((s) => [s.meta.code, s]));
      rows = codes.map((code) => {
        const snap = byCode.get(code);
        return {
          code,
          name: snap?.meta.name ?? code,
          price: snap?.price ?? null,
          ret_1d: snap?.returns.ret_1d ?? null,
          ret_20d: snap?.returns.ret_20d ?? null,
          ret_90d: snap?.returns.ret_90d ?? null,
          ret_250d: snap?.returns.ret_250d ?? null,
        };
      });
      table = formatStockTable(rows);
    } catch {
      // Snapshot fetch failed — fall back to a bare code list so the user
      // still sees the matches; no structured rows in this branch.
      table = codes.join(', ');
    }
    const text = `${head}\n\n${table}${tail}`;
    if (rows === null) return okResult(text);
    // Surface the rows on `output.meta` so the Feishu adapter renders the
    // schema-2.0 native `table` element instead of falling back to
    // ASCII-padded markdown (which Feishu can't align).
    return okResultWithMeta(text, {
      stockTableRows: stockTableMetaRows(rows),
      stockTableSubheader: `${head}${tail.length > 0 ? `  ·  ${tail.trim()}` : ''}`,
    });
  }
}
