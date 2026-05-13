/**
 * Per-user LLM ledger — append-only history of every LLM call charged
 * to that user, plus simple aggregations exposed via `/usr`.
 *
 * Backed by `UserScopedRecordStore<UserLlmLedgerRow>` — singleton row
 * per user, full `{ schemaVersion, entries[] }` JSON-encoded in
 * `payload_json`. Reads stay O(N) over the entries array; that's fine
 * because `/usr` is the only consumer.
 *
 * Self-migration: legacy `data/users/{userId}/llm-ledger.json` is
 * adopted on first access and renamed `.bak`.
 */

import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { FileSystemUserScopedRecordStore } from '../../../common/storage/adapters/filesystem-user-scoped-record.store.js';
import type {
  RecordTableSpec,
} from '../../../common/storage/ports/record-store.port.js';
import type { UserScopedRecordStore } from '../../../common/storage/ports/user-scoped-record-store.port.js';
import { USER_LLM_LEDGER_USER_RECORD_STORE } from '../llm.tokens.js';
import {
  EMPTY_USER_LLM_LEDGER,
  UserLlmLedgerSchema,
  type UserLlmLedger,
  type UserLlmLedgerEntry,
} from './user-llm-ledger.types.js';

const SINGLETON_KEY = 'singleton' as const;

export interface UserLlmLedgerRow {
  readonly id: typeof SINGLETON_KEY;
  readonly payload_json: string;
}

export const UserLlmLedgerRowSchema = z.object({
  id: z.literal(SINGLETON_KEY),
  payload_json: z.string(),
});

export const USER_LLM_LEDGER_TABLE_SPEC: RecordTableSpec<UserLlmLedgerRow> = {
  table: 'user_llm_ledger',
  schema: UserLlmLedgerRowSchema,
  pk: (row) => row.id,
  columns: [
    { name: 'id', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'payload_json', type: 'VARCHAR', nullable: false },
  ],
};

function decodeLegacy(raw: unknown): readonly UserLlmLedgerRow[] {
  const result = UserLlmLedgerSchema.safeParse(raw);
  if (!result.success) return [];
  return [{ id: SINGLETON_KEY, payload_json: JSON.stringify(result.data) }];
}

export function buildUserLlmLedgerUserScopedStore(
  dataRoot: string,
  logger: { warn: (m: string) => void; log?: (m: string) => void },
): UserScopedRecordStore<UserLlmLedgerRow> {
  return new FileSystemUserScopedRecordStore<UserLlmLedgerRow>({
    dataRoot,
    spec: USER_LLM_LEDGER_TABLE_SPEC,
    legacyJsonPath: (uid) => path.join(dataRoot, 'users', uid, 'llm-ledger.json'),
    legacyDecode: decodeLegacy,
    logger,
  });
}

export interface UserLlmLedgerSummary {
  readonly totalCnyCost: number;
  readonly totalUsage: { readonly input: number; readonly output: number; readonly total: number };
  readonly callCount: number;
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
  private readonly mutexByUser = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(USER_LLM_LEDGER_USER_RECORD_STORE)
    private readonly inner: UserScopedRecordStore<UserLlmLedgerRow>,
  ) {
    void this.logger;
  }

  async append(userId: string, entry: UserLlmLedgerEntry): Promise<void> {
    await this.mutate(userId, (current) => ({
      schemaVersion: current.schemaVersion,
      entries: [...current.entries, entry],
    }));
  }

  async list(userId: string): Promise<readonly UserLlmLedgerEntry[]> {
    const snap = await this.loadSnap(userId);
    return snap.entries;
  }

  async summarize(userId: string, since: Date | null = null): Promise<UserLlmLedgerSummary> {
    const sinceIso = since === null ? null : since.toISOString();
    const entries = (await this.list(userId)).filter((e) => sinceIso === null || e.ts >= sinceIso);
    return aggregate(entries);
  }

  async flushNow(userId: string): Promise<void> {
    await this.inner.flush(userId);
  }

  private async loadSnap(userId: string): Promise<UserLlmLedger> {
    const row = await this.inner.get(userId, SINGLETON_KEY);
    if (row === null) return structuredClone(EMPTY_USER_LLM_LEDGER);
    try {
      const parsed = JSON.parse(row.payload_json) as UserLlmLedger;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.entries)) return parsed;
    } catch {
      // fall through
    }
    return structuredClone(EMPTY_USER_LLM_LEDGER);
  }

  private async mutate(
    userId: string,
    apply: (current: UserLlmLedger) => UserLlmLedger,
  ): Promise<void> {
    await this.withUserLock(userId, async () => {
      const current = await this.loadSnap(userId);
      const next = apply(current);
      await this.inner.upsert(userId, {
        id: SINGLETON_KEY,
        payload_json: JSON.stringify(next),
      });
      await this.inner.flush(userId);
    });
  }

  private async withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexByUser.get(userId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.mutexByUser.set(
      userId,
      next.catch(() => undefined),
    );
    return next;
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
