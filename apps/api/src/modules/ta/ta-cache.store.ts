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
 *
 * Self-migration: legacy `data/ta/{code}.json` files are imported on
 * first `get` for that code, then renamed `.bak`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TaAnalysisSchema, type TaAnalysis } from '@quant/shared';
import { z } from 'zod';

import type {
  RecordStore,
  RecordTableSpec,
} from '../../common/storage/ports/record-store.port.js';
import { TA_CACHE_RECORD_STORE, TA_DATA_DIR } from './ta.token.js';

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

  constructor(
    @Inject(TA_CACHE_RECORD_STORE) private readonly store: RecordStore<TaCacheRow>,
    @Inject(TA_DATA_DIR) private readonly legacyRoot: string,
  ) {}

  async get(code: string, asof: string): Promise<TaAnalysis | null> {
    const row = await this.store.get(code);
    if (row !== null) {
      if (row.asof !== asof) return null;
      return this.decodeRow(row);
    }
    const legacy = await this.tryAdoptLegacy(code);
    if (legacy === null) return null;
    if (legacy.asof !== asof) return null;
    return legacy;
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

  /** Visible for tests / migration scripts. */
  legacyFilePath(code: string): string {
    return path.join(this.legacyRoot, 'ta', `${code}.json`);
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

  private async tryAdoptLegacy(code: string): Promise<TaAnalysis | null> {
    const legacy = this.legacyFilePath(code);
    let raw: string;
    try {
      raw = await fs.readFile(legacy, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn(`legacy ta ${legacy} malformed JSON, ignoring: ${String(err)}`);
      return null;
    }
    const result = TaAnalysisSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(`legacy ta ${legacy} failed validation: ${result.error.message}`);
      return null;
    }
    await this.runLocked(code, async () => {
      await this.store.upsert({
        code: result.data.code,
        asof: result.data.asof,
        payload_json: JSON.stringify(result.data),
      });
      await this.store.flush();
      try {
        await fs.rename(legacy, `${legacy}.bak`);
      } catch (err) {
        this.logger.warn(`could not rename legacy ta ${legacy} to .bak: ${String(err)}`);
      }
    });
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
