/**
 * HTTP route for pattern matching (modules/07-frontend.md §4.5).
 *
 *   POST /api/pattern/find_similar
 *
 * Body conforms to `PatternFindSimilarRequestSchema` (see
 * `@quant/shared`). Response conforms to
 * `PatternFindSimilarResponseSchema`.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import {
  PatternFindSimilarRequestSchema,
  type PatternFindSimilarRequest,
  type PatternFindSimilarResponse,
} from '@quant/shared';
import type { Request } from 'express';
import { Table } from 'apache-arrow';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { PATTERN_FLIGHT_CLIENT } from './pattern.token.js';

const bodyPipe = new ZodValidationPipe(PatternFindSimilarRequestSchema);

@Controller('pattern')
export class PatternController {
  constructor(@Inject(PATTERN_FLIGHT_CLIENT) private readonly flight: FlightClient) {}

  @Post('find_similar')
  async findSimilar(
    @Req() req: Request,
    @Body(bodyPipe) body: PatternFindSimilarRequest,
  ): Promise<PatternFindSimilarResponse> {
    const r = req as Request & { traceId?: string };
    const traceId = r.traceId ?? '';
    // Universe is intentionally NOT forwarded — the python op
    // ``find_similar_patterns`` falls back to the full meta universe
    // when ``universe`` is absent / empty (see services/py
    // /quant_rpc/ops/pattern.py). Pattern matching is meaningful only
    // against the broadest cohort, so we always run global.
    const args: Record<string, unknown> = {
      code: body.code,
      start_date: body.startDate,
      end_date: body.endDate,
      lookback_days: body.lookbackDays,
      top_n: body.topN,
    };
    const result = await this.flight.doGet('find_similar_patterns', args, { traceId });
    const payload = extractFirstPayload(result.value);
    if (payload === null) {
      throw new BadRequestException({
        code: 'PATTERN_FAILED',
        message: 'find_similar_patterns returned no payload',
        details: { code: body.code },
      });
    }
    return payload as PatternFindSimilarResponse;
  }
}

function extractFirstPayload(table: Table): unknown | null {
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
