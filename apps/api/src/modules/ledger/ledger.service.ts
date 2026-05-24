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

import { CLOCK, type Clock } from '../../common/clock.js';
import { LlmService } from '../llm/llm.service.js';
import type { LedgerPatchBody } from './dto/ledger.dto.js';
import { LedgerCacheStore } from './ledger-cache.store.js';
import { LedgerStore } from './ledger.store.js';
import { buildLedgerSystemPrompt, buildLedgerUserPrompt } from '@quant/config/prompts';

const MAX_AI_WINDOW = 30;
const MAX_BREACHES = 3;
const MAX_PHASES = 4;
const MAX_INTERVENTIONS = 3;

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
  const first = window[0];
  const last = window[window.length - 1];
  if (first === undefined || last === undefined) {
    throw new QuantError('LLM_FAILED', 'ledger window is empty', {});
  }
  const obj = payload as Readonly<Record<string, unknown>>;
  const candidate = {
    coreMetrics: decodeCoreMetrics(obj['core_metrics']),
    behavioralProfiling: decodeBehavioral(obj['behavioral_profiling']),
    marketMicrostructure: decodePhases(obj['market_microstructure']),
    systemicInterventions: decodeInterventions(obj['systemic_interventions']),
    generatedAt: generatedAt.toISOString(),
    windowStart: first.date,
    windowEnd: last.date,
    entryCount: window.length,
    provider,
  };
  const parsed = LedgerAnalysisSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new QuantError('LLM_FAILED', 'ledger output failed schema validation', {
      issues: parsed.error.issues.slice(0, 5),
    });
  }
  return parsed.data;
}

function asObj(raw: unknown, key: string): Readonly<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new QuantError('LLM_FAILED', `ledger output '${key}' must be an object`, {
      got: typeof raw,
    });
  }
  return raw as Readonly<Record<string, unknown>>;
}

function asNumber(raw: unknown, key: string): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  throw new QuantError('LLM_FAILED', `ledger output '${key}' must be a finite number`, {
    got: typeof raw,
  });
}

function asNumberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(raw: unknown, key: string): string {
  if (typeof raw !== 'string') {
    throw new QuantError('LLM_FAILED', `ledger output '${key}' must be a string`, {
      got: typeof raw,
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new QuantError('LLM_FAILED', `ledger output '${key}' is empty`, {});
  }
  return trimmed;
}

function asDecimalString(raw: unknown, key: string): string {
  if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/u.test(raw.trim())) return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw.toString();
  throw new QuantError('LLM_FAILED', `ledger output '${key}' must be a decimal`, {
    got: typeof raw,
  });
}

function decodeCoreMetrics(raw: unknown): unknown {
  const obj = asObj(raw, 'core_metrics');
  const dd = asObj(obj['max_drawdown'], 'core_metrics.max_drawdown');
  const pc = asObj(obj['profit_concentration'], 'core_metrics.profit_concentration');
  const cf = asObj(obj['net_cash_flow'], 'core_metrics.net_cash_flow');
  return {
    winRatePct: asNumber(obj['win_rate_pct'], 'core_metrics.win_rate_pct'),
    pnlRatio: asNumberOrNull(obj['pnl_ratio']),
    maxDrawdown: {
      valuePct: asNumber(dd['value_pct'], 'core_metrics.max_drawdown.value_pct'),
      startDate: asString(dd['start_date'], 'core_metrics.max_drawdown.start_date'),
      endDate: asString(dd['end_date'], 'core_metrics.max_drawdown.end_date'),
    },
    profitConcentration: {
      level: asString(pc['level'], 'core_metrics.profit_concentration.level'),
      corePeriod: asString(pc['core_period'], 'core_metrics.profit_concentration.core_period'),
      contributionPct: asNumber(
        pc['contribution_pct'],
        'core_metrics.profit_concentration.contribution_pct',
      ),
    },
    netCashFlow: {
      status: asString(cf['status'], 'core_metrics.net_cash_flow.status'),
      amount: asDecimalString(cf['amount'], 'core_metrics.net_cash_flow.amount'),
    },
  };
}

function decodeBehavioral(raw: unknown): unknown {
  const obj = asObj(raw, 'behavioral_profiling');
  const breachesRaw = obj['discipline_breaches'];
  const breaches: unknown[] = [];
  if (Array.isArray(breachesRaw)) {
    for (const item of breachesRaw) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const it = item as Readonly<Record<string, unknown>>;
      try {
        breaches.push({
          date: asString(it['date'], 'discipline_breaches[].date'),
          pnlPct: asNumber(it['pnl_pct'], 'discipline_breaches[].pnl_pct'),
          analysis: asString(it['analysis'], 'discipline_breaches[].analysis'),
        });
      } catch {
        // skip malformed individual breach
      }
      if (breaches.length >= MAX_BREACHES) break;
    }
  }
  return {
    patternDependency: asString(obj['pattern_dependency'], 'pattern_dependency'),
    disciplineBreaches: breaches,
    emotionalVolatility: asString(obj['emotional_volatility'], 'emotional_volatility'),
  };
}

function decodePhases(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const it = item as Readonly<Record<string, unknown>>;
    try {
      out.push({
        timeframe: asString(it['timeframe'], 'market_microstructure[].timeframe'),
        environment: asString(it['environment'], 'market_microstructure[].environment'),
      });
    } catch {
      // skip malformed phase
    }
    if (out.length >= MAX_PHASES) break;
  }
  return out;
}

function decodeInterventions(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const it = item as Readonly<Record<string, unknown>>;
    try {
      out.push({
        command: asString(it['command'], 'systemic_interventions[].command'),
        condition: asString(it['condition'], 'systemic_interventions[].condition'),
        action: asString(it['action'], 'systemic_interventions[].action'),
        rationale: asString(it['rationale'], 'systemic_interventions[].rationale'),
      });
    } catch {
      // skip malformed intervention
    }
    if (out.length >= MAX_INTERVENTIONS) break;
  }
  return out;
}

const FENCE_RE = /^```(?:json)?\s*([\s\S]+?)```$/u;

function stripFence(raw: string): string {
  const text = raw.trim();
  const fenced = FENCE_RE.exec(text);
  return fenced !== null ? (fenced[1]?.trim() ?? text) : text;
}

export { EnrichedLedgerEntrySchema };
