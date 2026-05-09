/**
 * HTTP routes for technical analysis (beta).
 *
 *   GET  /api/ta/analyze_one?code=xxx  → cached read; 404 on miss
 *   POST /api/ta/analyze_one {code,...} → fresh analysis (LLM, paid)
 *   POST /api/ta/analyze_many {codes,...} → sector fan-out + LLM summary
 *
 * Sector fan-out is intentionally NestJS-side (not Python): per-stock TA
 * is already an `analyze_ta_one` Flight call with its own cache, and the
 * sector summary is one extra `LlmService.completeJson` call. Keeping
 * the orchestration here avoids a new Python RPC handler (CLAUDE.md
 * §2.5.2 Rule of Three — first multi-stock TA caller).
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  TaSectorAnalysisSchema,
  type TaAnalysis,
  type TaSectorAnalysis,
  type TaSectorMember,
} from '@quant/shared';
import { Table } from 'apache-arrow';
import { z } from 'zod';
import type { Request } from 'express';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { CLOCK, type Clock } from '../../common/clock.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/request-with-user.js';
import { LlmService } from '../llm/llm.service.js';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { mapTaAnalysisToView } from './domain/payload-mapper.js';
import {
  AnalyzeTaOneBodySchema,
  AnalyzeTaOneQuerySchema,
  type AnalyzeTaOneBody,
  type AnalyzeTaOneQuery,
} from './dto/ta.dto.js';
import { buildSectorSummaryPrompt } from './prompts/sector-summary.prompt.js';
import { TA_FLIGHT_CLIENT } from './ta.token.js';

const queryPipe = new ZodValidationPipe(AnalyzeTaOneQuerySchema);
const bodyPipe = new ZodValidationPipe(AnalyzeTaOneBodySchema);

const codeRule = z.string().regex(/^\d{6}$/u, 'expected 6-digit code');
const AnalyzeTaManyBodySchema = z
  .object({
    codes: z.array(codeRule).min(1).max(50),
    label: z.string().min(1).optional(),
    bypassCache: z.boolean().optional(),
  })
  .strict();
type AnalyzeTaManyBody = z.infer<typeof AnalyzeTaManyBodySchema>;
const manyBodyPipe = new ZodValidationPipe(AnalyzeTaManyBodySchema);

@Controller('ta')
export class TaController {
  constructor(
    @Inject(TA_FLIGHT_CLIENT) private readonly flight: FlightClient,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('analyze_one')
  async getOneCached(
    @Req() req: Request,
    @Query(queryPipe) query: AnalyzeTaOneQuery,
  ): Promise<TaAnalysis> {
    const traceId = traceOf(req);
    const result = await this.flight.doGet('get_cached_ta_one', { code: query.code }, { traceId });
    const payload = extractFirstPayload(result.value);
    if (payload === null) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: `no cached ta for ${query.code}`,
        details: { code: query.code },
      });
    }
    return mapTaAnalysisToView(payload);
  }

  @Post('analyze_one')
  async analyzeOne(
    @Req() req: Request,
    @Body(bodyPipe) body: AnalyzeTaOneBody,
  ): Promise<TaAnalysis> {
    const traceId = traceOf(req);
    const args: Record<string, unknown> = { code: body.code };
    if (body.bypassCache !== undefined) args['bypass_cache'] = body.bypassCache;
    const result = await this.flight.doGet('analyze_ta_one', args, { traceId });
    const payload = extractFirstPayload(result.value);
    if (payload === null) {
      throw new BadRequestException({
        code: 'LLM_FAILED',
        message: 'analyze_ta_one returned no payload',
        details: { code: body.code },
      });
    }
    return mapTaAnalysisToView(payload);
  }

  @Post('analyze_many')
  async analyzeMany(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
    @Body(manyBodyPipe) body: AnalyzeTaManyBody,
  ): Promise<TaSectorAnalysis> {
    const traceId = traceOf(req);
    const codes = [...body.codes];

    // Fan-out per-stock TA — each call is cached on the Python side, so
    // a re-run of a sector that's seen recent activity hits cache for
    // every member. Concurrency is bounded by `Promise.all` of N items
    // (caller cap = 50 in the body schema).
    const settled = await Promise.allSettled(
      codes.map(async (code) => {
        const args: Record<string, unknown> = { code };
        if (body.bypassCache === true) args['bypass_cache'] = true;
        const result = await this.flight.doGet('analyze_ta_one', args, { traceId });
        const payload = extractFirstPayload(result.value);
        if (payload === null) {
          throw new Error(`empty payload for ${code}`);
        }
        return mapTaAnalysisToView(payload);
      }),
    );

    const members: TaSectorMember[] = [];
    const caveats: string[] = [];
    let up = 0;
    let down = 0;
    let sideways = 0;
    for (let i = 0; i < settled.length; i += 1) {
      const code = codes[i] ?? '';
      const r = settled[i];
      if (r === undefined) continue;
      if (r.status === 'rejected') {
        caveats.push(`${code}: ${describeError(r.reason)}`);
        continue;
      }
      const ta = r.value;
      if (ta.trend.direction === 'up') up += 1;
      else if (ta.trend.direction === 'down') down += 1;
      else sideways += 1;
      const member: TaSectorMember = {
        code: ta.code,
        name: '',
        asof: ta.asof,
        trend: ta.trend,
        keyResistance: ta.resistanceLevels[0]?.price ?? null,
        keySupport: ta.supportLevels[0]?.price ?? null,
        headline: ta.trend.rationale,
      };
      members.push(member);
    }

    if (members.length === 0) {
      throw new BadRequestException({
        code: 'EVALUATION_FAILED',
        message: 'no member TA could be produced',
        details: { codes, caveats },
      });
    }

    const overallDirection = pickOverallDirection({ up, down, sideways });
    const overallConfidence = avgConfidence(members, overallDirection);

    const label = body.label ?? `${String(members.length)} codes`;
    const summary = await this.summarise({
      label,
      members,
      trendBreakdown: { up, down, sideways },
      overallDirection,
      overallConfidence,
      ctx: { userId: user.id, traceId, scope: 'ta' },
    });

    const out: TaSectorAnalysis = {
      codes,
      trendBreakdown: { up, down, sideways },
      overallDirection,
      overallConfidence,
      members,
      summary,
      caveats,
      cachedAt: this.clock.now().toISOString(),
    };
    return TaSectorAnalysisSchema.parse(out);
  }

  private async summarise(input: {
    readonly label: string;
    readonly members: readonly TaSectorMember[];
    readonly trendBreakdown: { readonly up: number; readonly down: number; readonly sideways: number };
    readonly overallDirection: 'up' | 'down' | 'sideways';
    readonly overallConfidence: number;
    readonly ctx: { readonly userId: string; readonly traceId: string; readonly scope: 'ta' };
  }): Promise<string> {
    const prompt = buildSectorSummaryPrompt({
      sectorLabel: input.label,
      members: input.members,
      trendBreakdown: input.trendBreakdown,
      overallDirection: input.overallDirection,
      overallConfidence: input.overallConfidence,
    });
    try {
      const out = await this.llm.completeJson(
        { system: prompt.system, user: prompt.user },
        input.ctx,
      );
      return out.text.trim();
    } catch {
      // Sector view degrades gracefully — caller still gets the
      // numerical aggregate; we just surface a non-blocking caveat.
      return '';
    }
  }
}

function traceOf(req: Request): string {
  const r = req as Request & { traceId?: string };
  return r.traceId ?? '';
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function pickOverallDirection(b: {
  readonly up: number;
  readonly down: number;
  readonly sideways: number;
}): 'up' | 'down' | 'sideways' {
  if (b.up >= b.down && b.up >= b.sideways) return 'up';
  if (b.down >= b.up && b.down >= b.sideways) return 'down';
  return 'sideways';
}

function avgConfidence(
  members: readonly TaSectorMember[],
  direction: 'up' | 'down' | 'sideways',
): number {
  let sum = 0;
  let count = 0;
  for (const m of members) {
    if (m.trend.direction !== direction) continue;
    sum += m.trend.confidence;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

function extractFirstPayload(table: Table): unknown {
  if (table.numRows === 0) return null;
  const proxy = table.get(0);
  if (proxy === null) return null;
  const row = proxy.toJSON() as { payload_json?: unknown };
  const json = row.payload_json;
  if (typeof json !== 'string' || json.length === 0) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
