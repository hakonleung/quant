/**
 * HTTP route for the NL → DSL → screen pipeline
 * (modules/03-screening.md + modules/07-frontend.md §4.3.3).
 *
 *   POST /api/screen/nl  { nl: string, asof?: YYYY-MM-DD }
 *     →  NlScreenResult — matches + parsed AST
 *
 * Why POST: the underlying op invokes a paid LLM call (CLAUDE.md
 * cache-mutating-must-be-POST rule). The frontend uses a mutation
 * hook; there is no GET twin (the AST + matches change per NL input,
 * so caching beyond the react-query mutation result has little value).
 */

import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import { NlScreenResultSchema, type NlScreenResult } from '@quant/shared';
import type { Request } from 'express';
import type { Table } from 'apache-arrow';
import { z } from 'zod';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { SCREEN_FLIGHT_CLIENT } from './screen.token.js';

const NlScreenBodySchema = z
  .object({
    nl: z.string().min(1).max(500),
    asof: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();
type NlScreenBody = z.infer<typeof NlScreenBodySchema>;
const nlBodyPipe = new ZodValidationPipe(NlScreenBodySchema);

@Controller('screen')
export class ScreenController {
  constructor(@Inject(SCREEN_FLIGHT_CLIENT) private readonly flight: FlightClient) {}

  @Post('nl')
  async run(
    @Req() req: Request,
    @Body(nlBodyPipe) body: NlScreenBody,
  ): Promise<NlScreenResult> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    const args: Record<string, unknown> = { nl: body.nl };
    if (body.asof !== undefined) args['asof'] = body.asof;
    const result = await this.flight.doGet('nl_screen', args, { traceId });
    const payload = extractFirstPayload(result.value);
    if (payload === null) {
      throw new BadRequestException({
        code: 'NL_TRANSLATION_FAILED',
        message: 'nl_screen returned no payload',
        details: { nl: body.nl },
      });
    }
    return NlScreenResultSchema.parse(payload);
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
