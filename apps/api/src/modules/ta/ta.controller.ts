/**
 * HTTP routes for technical analysis (beta).
 *
 *   GET  /api/ta/analyze_one?code=xxx  → cached read; 404 on miss
 *   POST /api/ta/analyze_one {code,...} → fresh analysis (LLM, paid)
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
import type { TaAnalysis } from '@quant/shared';
import { Table } from 'apache-arrow';
import type { Request } from 'express';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { mapTaAnalysisToView } from './domain/payload-mapper.js';
import {
  AnalyzeTaOneBodySchema,
  AnalyzeTaOneQuerySchema,
  type AnalyzeTaOneBody,
  type AnalyzeTaOneQuery,
} from './dto/ta.dto.js';
import { TA_FLIGHT_CLIENT } from './ta.token.js';

const queryPipe = new ZodValidationPipe(AnalyzeTaOneQuerySchema);
const bodyPipe = new ZodValidationPipe(AnalyzeTaOneBodySchema);

@Controller('ta')
export class TaController {
  constructor(@Inject(TA_FLIGHT_CLIENT) private readonly flight: FlightClient) {}

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
}

function traceOf(req: Request): string {
  const r = req as Request & { traceId?: string };
  return r.traceId ?? '';
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
