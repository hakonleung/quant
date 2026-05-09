/**
 * Thin facade over the Python `nl_screen` / `nl_to_dsl` / `screen_run`
 * Flight ops. Centralises the `extractFirstPayload` glue so the HTTP
 * controller and the IM `/screen` instruction handler share one
 * implementation rather than each calling `flight.doGet` directly.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  NlScreenResultSchema,
  NlToDslResultSchema,
  QuantError,
  ScreenRunResultSchema,
  type NlScreenResult,
  type NlToDslResult,
  type RankSpecView,
  type ScreenPlanAst,
  type ScreenRunResult,
  type UniversePlanAst,
} from '@quant/shared';
import type { Table } from 'apache-arrow';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { SCREEN_FLIGHT_CLIENT } from './screen.token.js';

@Injectable()
export class ScreenService {
  constructor(@Inject(SCREEN_FLIGHT_CLIENT) private readonly flight: FlightClient) {}

  async runNl(nl: string, asof: string | undefined, traceId: string): Promise<NlScreenResult> {
    const args: Record<string, unknown> = { nl };
    if (asof !== undefined) args['asof'] = asof;
    const payload = await this.callOp('nl_screen', args, traceId);
    if (payload === null) {
      throw new QuantError('NL_TRANSLATION_FAILED', 'nl_screen returned no payload', { nl });
    }
    return NlScreenResultSchema.parse(payload);
  }

  async nlToDsl(nl: string, asof: string | undefined, traceId: string): Promise<NlToDslResult> {
    const args: Record<string, unknown> = { nl };
    if (asof !== undefined) args['asof'] = asof;
    const payload = await this.callOp('nl_to_dsl', args, traceId);
    if (payload === null) {
      throw new QuantError('NL_TRANSLATION_FAILED', 'nl_to_dsl returned no payload', { nl });
    }
    return NlToDslResultSchema.parse(payload);
  }

  async runDsl(
    screenPlan: ScreenPlanAst,
    universePlan: UniversePlanAst | null | undefined,
    rank: RankSpecView | null | undefined,
    traceId: string,
  ): Promise<ScreenRunResult> {
    // Flight args are flat primitives — nested AST goes through as a
    // JSON string and the python op deserialises it back to a domain
    // object (see services/py/quant_rpc/ops/screen_ops.py).
    const args: Record<string, unknown> = {
      screen_plan: JSON.stringify(screenPlan),
    };
    if (universePlan !== undefined && universePlan !== null) {
      args['universe_plan'] = JSON.stringify(universePlan);
    }
    if (rank !== undefined && rank !== null) {
      args['rank'] = JSON.stringify(rank);
    }
    const payload = await this.callOp('screen_run', args, traceId);
    if (payload === null) {
      throw new QuantError('DSL_INVALID', 'screen_run returned no payload', {});
    }
    return ScreenRunResultSchema.parse(payload);
  }

  private async callOp(
    op: string,
    args: Record<string, unknown>,
    traceId: string,
  ): Promise<unknown> {
    const result = await this.flight.doGet(op, args, { traceId });
    return extractFirstPayload(result.value);
  }
}

function extractFirstPayload(table: Table): unknown {
  if (table.numRows === 0) return null;
  const proxy = table.get(0);
  if (proxy === null) return null;
  const row: Readonly<Record<string, unknown>> = proxy.toJSON();
  const json = row['payload_json'];
  if (typeof json !== 'string' || json.length === 0) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
