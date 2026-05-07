import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  ScreenRunResultSchema,
  SectorsReplaceBodySchema,
  type ScreenRunResult,
  type Sector,
  type SectorsReplaceBody,
} from '@quant/shared';
import type { Table } from 'apache-arrow';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { CLOCK, type Clock } from '../../common/clock.js';
import { type RequestWithTraceId } from '../../common/trace.middleware.js';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { SectorsStore } from './sectors.store.js';
import { SECTORS_FLIGHT_CLIENT } from './sectors.token.js';

const replacePipe = new ZodValidationPipe(SectorsReplaceBodySchema);

@Controller('sectors')
export class SectorsController {
  constructor(
    @Inject(SectorsStore) private readonly store: SectorsStore,
    @Inject(SECTORS_FLIGHT_CLIENT) private readonly flight: FlightClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  list(): { readonly sectors: readonly Sector[] } {
    return { sectors: this.store.list() };
  }

  @Put()
  async replace(
    @Body(replacePipe) body: SectorsReplaceBody,
  ): Promise<{ readonly sectors: readonly Sector[] }> {
    const sectors = await this.store.replace(body.sectors);
    return { sectors };
  }

  @Post(':id/refresh')
  async refresh(
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
  ): Promise<{ readonly sector: Sector }> {
    const current = this.store.list().find((s) => s.id === id);
    if (current === undefined) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: `sector ${id} not found` });
    }
    if (current.kind !== 'dynamic') {
      throw new BadRequestException({
        code: 'INVALID_ARGUMENT',
        message: `sector ${id} is not dynamic`,
      });
    }
    if (current.screenPlan === undefined) {
      throw new BadRequestException({
        code: 'INVALID_ARGUMENT',
        message: `sector ${id} has no screenPlan to re-run`,
      });
    }
    const traceId = req.traceId;
    const args: Record<string, unknown> = {
      screen_plan: JSON.stringify(current.screenPlan),
    };
    if (current.universePlan !== undefined && current.universePlan !== null) {
      args['universe_plan'] = JSON.stringify(current.universePlan);
    }
    if (current.rank !== undefined && current.rank !== null) {
      args['rank'] = JSON.stringify(current.rank);
    }
    const result = await this.flight.doGet('screen_run', args, { traceId });
    const payload = extractFirstPayload(result.value);
    if (payload === null) {
      throw new BadRequestException({
        code: 'EVALUATION_FAILED',
        message: 'screen_run returned no payload',
      });
    }
    const parsed: ScreenRunResult = ScreenRunResultSchema.parse(payload);
    const codes = parsed.matches.map((m) => m.code);
    const evidence: Record<string, Record<string, unknown>> = {};
    for (const m of parsed.matches) {
      evidence[m.code] = m.evidence;
    }
    const refreshed: Sector = {
      ...current,
      codes,
      count: codes.length,
      evidence,
      lastScreenedAt: this.clock.now().toISOString(),
    };
    const sector = await this.store.upsert(refreshed);
    return { sector };
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
