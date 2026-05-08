/**
 * Business orchestration for the ledger feature.
 *
 *   - CRUD on the persisted entries (uses `LedgerStore`)
 *   - merge-import with full validation
 *   - AI analysis: enrich → hash → cache lookup → Flight call → cache write
 *
 * Every public method takes `userId` as the first parameter; the
 * controller derives it from `@CurrentUser()` and the IM dispatcher
 * from `AuthService.resolveFromIm()`.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  EnrichedLedgerEntrySchema,
  LedgerAnalysisSchema,
  QuantError,
  enrichEntries,
  mergeEntries,
  validateLedger,
  type EnrichedLedgerEntry,
  type LedgerAnalysis,
  type LedgerEntry,
  type LedgerSnapshot,
} from '@quant/shared';
import { Table } from 'apache-arrow';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { CLOCK, type Clock } from '../../common/clock.js';
import type { LedgerPatchBody } from './dto/ledger.dto.js';
import { LedgerCacheStore } from './ledger-cache.store.js';
import { LedgerStore } from './ledger.store.js';
import { LEDGER_FLIGHT_CLIENT } from './ledger.token.js';

const MAX_AI_WINDOW = 30;

@Injectable()
export class LedgerService {
  constructor(
    @Inject(LedgerStore) private readonly store: LedgerStore,
    @Inject(LedgerCacheStore) private readonly cache: LedgerCacheStore,
    @Inject(LEDGER_FLIGHT_CLIENT) private readonly flight: FlightClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<readonly LedgerEntry[]> {
    return this.store.list(userId);
  }

  async enriched(userId: string): Promise<readonly EnrichedLedgerEntry[]> {
    return enrichEntries(await this.store.list(userId));
  }

  async create(userId: string, entry: LedgerEntry): Promise<LedgerEntry> {
    const existing = await this.store.list(userId);
    if (existing.some((e) => e.date === entry.date)) {
      throw new QuantError(
        'LEDGER_DUPLICATE_DATE',
        `ledger entry for ${entry.date} already exists`,
        { date: entry.date },
      );
    }
    const next = mergeEntries(existing, [entry]);
    await this.store.replace(userId, next);
    return entry;
  }

  async patch(userId: string, date: string, body: LedgerPatchBody): Promise<LedgerEntry> {
    const existing = await this.store.list(userId);
    const idx = existing.findIndex((e) => e.date === date);
    if (idx < 0) {
      throw new QuantError('NOT_FOUND', `ledger entry ${date} not found`, { date });
    }
    const current = existing[idx];
    if (current === undefined) {
      throw new QuantError('NOT_FOUND', `ledger entry ${date} not found`, { date });
    }
    const merged: LedgerEntry = {
      date: current.date,
      pnlAmount: body.pnlAmount ?? current.pnlAmount,
      ...(Object.prototype.hasOwnProperty.call(body, 'closingPosition')
        ? { closingPosition: body.closingPosition ?? null }
        : current.closingPosition !== undefined
          ? { closingPosition: current.closingPosition }
          : {}),
    };
    const nextList = [...existing];
    nextList[idx] = merged;
    await this.store.replace(userId, nextList);
    return merged;
  }

  async remove(userId: string, date: string): Promise<void> {
    const existing = await this.store.list(userId);
    if (!existing.some((e) => e.date === date)) {
      throw new QuantError('NOT_FOUND', `ledger entry ${date} not found`, { date });
    }
    const next = existing.filter((e) => e.date !== date);
    await this.store.replace(userId, next);
  }

  async importEntries(
    userId: string,
    entries: readonly LedgerEntry[],
  ): Promise<LedgerSnapshot> {
    const next = mergeEntries(await this.store.list(userId), entries);
    return this.store.replace(userId, next);
  }

  validateCandidate(entries: readonly LedgerEntry[]): void {
    const v = validateLedger(entries);
    if (!v.ok) {
      throw new QuantError(v.error.code, v.error.message);
    }
  }

  async cachedAnalysis(userId: string): Promise<LedgerAnalysis | null> {
    const enriched = enrichEntries(await this.store.list(userId));
    if (enriched.length === 0) return null;
    const window = enriched.slice(-MAX_AI_WINDOW);
    return this.cache.get(userId, LedgerCacheStore.keyFor(window));
  }

  async analyze(userId: string, traceId: string, bypassCache = false): Promise<LedgerAnalysis> {
    const enriched = enrichEntries(await this.store.list(userId));
    if (enriched.length === 0) {
      throw new QuantError('LLM_FAILED', 'ledger is empty — nothing to analyze', {});
    }
    const window = enriched.slice(-MAX_AI_WINDOW);
    const key = LedgerCacheStore.keyFor(window);

    if (!bypassCache) {
      const hit = await this.cache.get(userId, key);
      if (hit !== null) return hit;
    }

    const args: Record<string, unknown> = {
      entries: window.map((e) => ({
        date: e.date,
        pnl_amount: e.pnlAmount,
        closing_position: e.derivedClosingPosition,
        closing_provided: e.closingProvided,
        cash_flow: e.cashFlow,
        derived_daily_pct: e.derivedDailyPct,
      })),
      asof: this.clock.now().toISOString().slice(0, 10),
    };
    const result = await this.flight.doGet('analyze_ledger', args, { traceId });
    const payload = extractFirstPayload(result.value);
    if (payload === null) {
      throw new QuantError('LLM_FAILED', 'analyze_ledger returned no payload', {});
    }
    const analysis = LedgerAnalysisSchema.parse(payload);
    await this.cache.put(userId, key, analysis);
    return analysis;
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

export { EnrichedLedgerEntrySchema };
