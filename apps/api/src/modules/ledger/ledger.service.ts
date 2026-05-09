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
  QuantError,
  enrichEntries,
  mergeEntries,
  validateLedger,
  type EnrichedLedgerEntry,
  type LedgerAnalysis,
  type LedgerEntry,
  type LedgerSnapshot,
} from '@quant/shared';

import { CLOCK, type Clock } from '../../common/clock.js';
import { LlmService } from '../llm/llm.service.js';
import type { LedgerPatchBody } from './dto/ledger.dto.js';
import { LedgerCacheStore } from './ledger-cache.store.js';
import { LedgerStore } from './ledger.store.js';
import {
  buildLedgerSystemPrompt,
  buildLedgerUserPrompt,
} from './prompts/analyze.prompt.js';

const MAX_AI_WINDOW = 30;
const MAX_RECOMMENDATIONS = 5;

@Injectable()
export class LedgerService {
  constructor(
    @Inject(LedgerStore) private readonly store: LedgerStore,
    @Inject(LedgerCacheStore) private readonly cache: LedgerCacheStore,
    @Inject(LlmService) private readonly llm: LlmService,
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

  async importEntries(userId: string, entries: readonly LedgerEntry[]): Promise<LedgerSnapshot> {
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

    const system = buildLedgerSystemPrompt();
    const user = buildLedgerUserPrompt(window);
    const out = await this.llm.completeJson(
      { system, user },
      { userId, traceId, scope: 'analyze' },
    );
    const analysis = parseLedgerAnalysis(out.text, window, out.provider, this.clock.now());
    await this.cache.put(userId, key, analysis);
    return analysis;
  }
}

// ---------------------------------------------------------------------------
// pure JSON → LedgerAnalysis decoder (replaces the Python ledger_service)
// ---------------------------------------------------------------------------

function parseLedgerAnalysis(
  raw: string,
  window: readonly EnrichedLedgerEntry[],
  provider: string,
  generatedAt: Date,
): LedgerAnalysis {
  const text = stripFence(raw);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QuantError('LLM_FAILED', `ledger output is not valid JSON: ${msg}`, {
      snippet: raw.slice(0, 200),
    });
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new QuantError('LLM_FAILED', 'ledger output is not a JSON object', {});
  }
  const obj = payload as Readonly<Record<string, unknown>>;
  const summary = decodeNonEmptyString(obj['summary'], 'summary');
  const operationStyle = decodeNonEmptyString(obj['operation_style'], 'operation_style');
  const marketView = decodeNonEmptyString(obj['market_view'], 'market_view');
  const recommendations = decodeStringList(obj['recommendations']);
  const first = window[0];
  const last = window[window.length - 1];
  if (first === undefined || last === undefined) {
    throw new QuantError('LLM_FAILED', 'ledger window is empty', {});
  }
  return {
    summary,
    operationStyle,
    marketView,
    recommendations: [...recommendations],
    generatedAt: generatedAt.toISOString(),
    windowStart: first.date,
    windowEnd: last.date,
    entryCount: window.length,
    provider,
  };
}

function decodeNonEmptyString(raw: unknown, key: string): string {
  if (typeof raw !== 'string') {
    throw new QuantError('LLM_FAILED', `ledger output '${key}' must be a string`, {
      got: typeof raw,
    });
  }
  const stripped = raw.trim();
  if (stripped.length === 0) {
    throw new QuantError('LLM_FAILED', `ledger output '${key}' is empty`, {});
  }
  return stripped;
}

function decodeStringList(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
    if (out.length >= MAX_RECOMMENDATIONS) break;
  }
  return out;
}

const FENCE_RE = /^```(?:json)?\s*([\s\S]+?)```$/u;

function stripFence(raw: string): string {
  const text = raw.trim();
  const fenced = FENCE_RE.exec(text);
  return fenced !== null ? fenced[1]?.trim() ?? text : text;
}

export { EnrichedLedgerEntrySchema };
