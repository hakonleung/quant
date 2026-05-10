/**
 * Per-user LLM ledger — append-only history of every LLM call charged
 * to that user, plus simple aggregations exposed via `/usr`.
 *
 * Backed by `UserScopedJsonStore`, so the same atomic-write + write-
 * throttle + LRU eviction guarantees apply as ledger / watch / focus.
 *
 * Reads are O(N) over the entries array; we accept that for v1 because
 * (a) `/usr` is the only reader, and (b) per-user entries are bounded
 * by usage rates rather than cardinality. Truncation / compaction is a
 * v2 concern.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import { UserScopedJsonStore } from '../../../common/user-scoped-store.js';
import { LLM_LEDGER_DATA_DIR } from '../llm.tokens.js';
import {
  EMPTY_USER_LLM_LEDGER,
  UserLlmLedgerSchema,
  type UserLlmLedger,
  type UserLlmLedgerEntry,
} from './user-llm-ledger.types.js';

const FILE_RELATIVE = (userId: string): string => `users/${userId}/llm-ledger.json`;

export interface UserLlmLedgerSummary {
  /** Sum across all scopes. */
  readonly totalCnyCost: number;
  readonly totalUsage: { readonly input: number; readonly output: number; readonly total: number };
  readonly callCount: number;
  /** Per-scope breakdown — same fields as the totals. */
  readonly byScope: ReadonlyMap<
    UserLlmLedgerEntry['scope'],
    {
      readonly cnyCost: number;
      readonly usage: { readonly input: number; readonly output: number; readonly total: number };
      readonly callCount: number;
    }
  >;
}

@Injectable()
export class UserLlmLedgerStore {
  private readonly logger = new Logger(UserLlmLedgerStore.name);
  private readonly store: UserScopedJsonStore<UserLlmLedger>;

  constructor(@Inject(LLM_LEDGER_DATA_DIR) dataRoot: string) {
    this.store = new UserScopedJsonStore<UserLlmLedger>(dataRoot, {
      relativePath: FILE_RELATIVE,
      schema: UserLlmLedgerSchema,
      fallback: () => structuredClone(EMPTY_USER_LLM_LEDGER),
      logger: { warn: (m: string) => this.logger.warn(m) },
    });
  }

  async append(userId: string, entry: UserLlmLedgerEntry): Promise<void> {
    await this.store.mutate(userId, (current) => ({
      schemaVersion: current.schemaVersion,
      entries: [...current.entries, entry],
    }));
  }

  async list(userId: string): Promise<readonly UserLlmLedgerEntry[]> {
    const snap = await this.store.snapshot(userId);
    return snap.entries;
  }

  /** Aggregate over all entries from `since` (inclusive) up to now. */
  async summarize(userId: string, since: Date | null = null): Promise<UserLlmLedgerSummary> {
    const sinceIso = since === null ? null : since.toISOString();
    const entries = (await this.list(userId)).filter((e) => sinceIso === null || e.ts >= sinceIso);
    return aggregate(entries);
  }

  async flushNow(userId: string): Promise<void> {
    await this.store.flushNow(userId);
  }
}

function aggregate(entries: readonly UserLlmLedgerEntry[]): UserLlmLedgerSummary {
  let totalCny = 0;
  let totalIn = 0;
  let totalOut = 0;
  const byScope = new Map<
    UserLlmLedgerEntry['scope'],
    { cnyCost: number; usage: { input: number; output: number; total: number }; callCount: number }
  >();
  for (const e of entries) {
    totalCny += e.cnyCost;
    totalIn += e.usage.input;
    totalOut += e.usage.output;
    const cur = byScope.get(e.scope);
    if (cur === undefined) {
      byScope.set(e.scope, {
        cnyCost: e.cnyCost,
        usage: { input: e.usage.input, output: e.usage.output, total: e.usage.total },
        callCount: 1,
      });
    } else {
      cur.cnyCost += e.cnyCost;
      byScope.set(e.scope, {
        cnyCost: cur.cnyCost,
        usage: {
          input: cur.usage.input + e.usage.input,
          output: cur.usage.output + e.usage.output,
          total: cur.usage.total + e.usage.total,
        },
        callCount: cur.callCount + 1,
      });
    }
  }
  return {
    totalCnyCost: Math.round(totalCny * 10_000) / 10_000,
    totalUsage: { input: totalIn, output: totalOut, total: totalIn + totalOut },
    callCount: entries.length,
    byScope,
  };
}
