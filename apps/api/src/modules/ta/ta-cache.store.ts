/**
 * File-per-code cache for `TaAnalysis`.
 *
 * Replaces the Python `ParquetTaCache` — TA payloads are deeply nested
 * JSON objects with no columnar benefit, and serving them from NestJS
 * lets the controller skip a Flight roundtrip for the cache lookup.
 *
 * Layout: `${dataRoot}/ta/{code}.json` — one stock per file, atomic
 * `tmp + rename` writes, schema-validated on read with zod fallback to
 * cache miss when the on-disk shape drifts.
 *
 * Cache key is `(code, asof)`. A request with a different `asof` than
 * the cached row counts as a miss (the LLM should re-analyze with the
 * fresh data). `asof` defaults to the latest stored bar's date so the
 * cache key follows the data, not the wall clock — same convention as
 * the deleted Python `ta_service`.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { TaAnalysisSchema, type TaAnalysis } from '@quant/shared';
import path from 'node:path';

import { atomicWriteJson, readJsonOr } from '../watch/domain/atomic-json.js';
import { TA_DATA_DIR } from './ta.token.js';

@Injectable()
export class TaCacheStore {
  private readonly logger = new Logger(TaCacheStore.name);
  private readonly mutexByCode = new Map<string, Promise<unknown>>();

  constructor(@Inject(TA_DATA_DIR) private readonly dataRoot: string) {}

  async get(code: string, asof: string): Promise<TaAnalysis | null> {
    const file = this.filePath(code);
    const raw = await readJsonOr<unknown>(file, null);
    if (raw === null) return null;
    const parsed = TaAnalysisSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(
        `ta_cache_invalid file=${file} err=${parsed.error.message.slice(0, 200)}`,
      );
      return null;
    }
    if (parsed.data.asof !== asof) return null;
    return parsed.data;
  }

  async put(value: TaAnalysis): Promise<void> {
    await this.runLocked(value.code, async () => {
      await atomicWriteJson(this.filePath(value.code), value);
    });
  }

  filePath(code: string): string {
    return path.join(this.dataRoot, 'ta', `${code}.json`);
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
