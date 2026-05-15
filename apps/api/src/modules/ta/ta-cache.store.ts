/**
 * Per-code cache for `TaAnalysis`. Backed by `RecordStore<TaCacheRow>`
 * — one row per `code`, full payload serialised in `payload_json`.
 *
 * Cache key is `(code, asof)`. A `get(code, asof)` with a mismatched
 * `asof` returns `null` so the LLM re-analyses with fresh data; same
 * convention as the Python `ta_service` that came before it.
 *
 * Why JSON-in-VARCHAR? `TaAnalysis` is deeply nested (signals,
 * indicators, narrative blocks) with no columnar query path today.
 * Same shortcut as `BlacklistStore`/`SectorsStore`.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { TaAnalysisSchema, type TaAnalysis } from '@quant/shared';
import { z } from 'zod';

import type { RecordStore, RecordTableSpec } from '../../common/storage/ports/record-store.port.js';
import { TA_CACHE_RECORD_STORE } from './ta.token.js';

export interface TaCacheRow {
  readonly code: string;
  readonly asof: string;
  readonly payload_json: string;
}

export const TaCacheRowSchema = z.object({
  code: z.string(),
  asof: z.string(),
  payload_json: z.string(),
});

export const TA_CACHE_TABLE_SPEC: RecordTableSpec<TaCacheRow> = {
  table: 'ta_cache',
  schema: TaCacheRowSchema,
  pk: (row) => row.code,
  columns: [
    { name: 'code', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'asof', type: 'VARCHAR', nullable: false },
    { name: 'payload_json', type: 'VARCHAR', nullable: false },
  ],
};

@Injectable()
export class TaCacheStore {
  private readonly logger = new Logger(TaCacheStore.name);
  private readonly mutexByCode = new Map<string, Promise<unknown>>();

  constructor(@Inject(TA_CACHE_RECORD_STORE) private readonly store: RecordStore<TaCacheRow>) {}

  async get(code: string, asof: string): Promise<TaAnalysis | null> {
    const row = await this.store.get(code);
    if (row === null) return null;
    if (row.asof !== asof) return null;
    return this.decodeRow(row);
  }

  async put(value: TaAnalysis): Promise<void> {
    await this.runLocked(value.code, async () => {
      await this.store.upsert({
        code: value.code,
        asof: value.asof,
        payload_json: JSON.stringify(value),
      });
      await this.store.flush();
    });
  }

  private decodeRow(row: TaCacheRow): TaAnalysis | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload_json);
    } catch (err) {
      this.logger.warn(`ta_cache_payload_invalid code=${row.code} err=${String(err)}`);
      return null;
    }
    const result = TaAnalysisSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(
        `ta_cache_invalid code=${row.code} err=${result.error.message.slice(0, 200)}`,
      );
      return null;
    }
    return result.data;
  }

  private async runLocked<R>(code: string, fn: () => Promise<R>): Promise<R> {
    const prev = this.mutexByCode.get(code) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.mutexByCode.set(
      code,
      next.catch(() => undefined),
    );
    return next;
  }
}
