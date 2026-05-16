/**
 * Per-user LLM ledger — append-only history of every LLM call charged
 * to that user, plus simple aggregations exposed via `/usr`.
 *
 * Backed by `UserScopedRecordStore<UserLlmLedgerRow>` — singleton row
 * per user, full `{ schemaVersion, entries[] }` JSON-encoded in
 * `payload_json`. Reads stay O(N) over the entries array; that's fine
 * because `/usr` is the only consumer.
 *
 * **Write batching (perf)**: `append()` pushes into an in-memory buffer
 * per user and returns immediately. A flush is triggered when either
 *   (a) the buffer reaches `FLUSH_SIZE` (10) entries, or
 *   (b) `FLUSH_INTERVAL_MS` (30s) has elapsed since the buffer started
 *       accumulating.
 * Without batching, every LLM call paid for a full parquet rewrite
 * (5-50ms) on the hot path; the buffer takes the rewrite off the
 * call's `finally` waitlist. Read paths (`list` / `summarize`) merge
 * the in-memory buffer with the persisted snapshot so callers never
 * see a stale view. `OnApplicationShutdown` drains every buffer.
 *
 * v1 payloads are down-converted to v2 (drop `provider`, `cnyCost`) on
 * read; the next mutate rewrites the parquet in v2 form.
 */

import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { z } from 'zod';

import { FileSystemUserScopedRecordStore } from '../../../common/storage/adapters/filesystem-user-scoped-record.store.js';
import type { RecordTableSpec } from '../../../common/storage/ports/record-store.port.js';
import type { UserScopedRecordStore } from '../../../common/storage/ports/user-scoped-record-store.port.js';
import { USER_LLM_LEDGER_USER_RECORD_STORE } from '../llm.tokens.js';
import {
  EMPTY_USER_LLM_LEDGER,
  migrateLedgerPayload,
  type UserLlmLedger,
  type UserLlmLedgerEntry,
} from './user-llm-ledger.types.js';

const SINGLETON_KEY = 'singleton' as const;

const FLUSH_SIZE = 10;
const FLUSH_INTERVAL_MS = 30_000;

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

export function buildUserLlmLedgerUserScopedStore(
  dataRoot: string,
  logger: { warn: (m: string) => void; log?: (m: string) => void },
): UserScopedRecordStore<UserLlmLedgerRow> {
  return new FileSystemUserScopedRecordStore<UserLlmLedgerRow>({
    dataRoot,
    spec: USER_LLM_LEDGER_TABLE_SPEC,
    logger,
  });
}

export interface UserLlmLedgerScopeAgg {
  readonly usage: { readonly input: number; readonly output: number; readonly total: number };
  readonly callCount: number;
}

export interface UserLlmLedgerSummary {
  readonly totalUsage: { readonly input: number; readonly output: number; readonly total: number };
  readonly callCount: number;
  readonly byScope: ReadonlyMap<UserLlmLedgerEntry['scope'], UserLlmLedgerScopeAgg>;
  readonly byModel: ReadonlyMap<string, UserLlmLedgerScopeAgg>;
}

@Injectable()
export class UserLlmLedgerStore implements OnApplicationShutdown {
  private readonly logger = new Logger(UserLlmLedgerStore.name);
  private readonly mutexByUser = new Map<string, Promise<unknown>>();
  private readonly bufferByUser = new Map<string, UserLlmLedgerEntry[]>();
  private readonly flushTimerByUser = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(USER_LLM_LEDGER_USER_RECORD_STORE)
    private readonly inner: UserScopedRecordStore<UserLlmLedgerRow>,
  ) {}

  /**
   * Buffered append. Returns once the entry is in the in-memory buffer
   * (no disk IO on the hot path). The persisted snapshot is rewritten
   * either when the buffer hits `FLUSH_SIZE` or after
   * `FLUSH_INTERVAL_MS` has elapsed since the first entry in the
   * current batch.
   */
  async append(userId: string, entry: UserLlmLedgerEntry): Promise<void> {
    const buf = this.bufferByUser.get(userId) ?? [];
    buf.push(entry);
    this.bufferByUser.set(userId, buf);
    if (buf.length >= FLUSH_SIZE) {
      await this.flushUser(userId);
      return;
    }
    if (!this.flushTimerByUser.has(userId)) {
      const timer = setTimeout(() => {
        this.flushUser(userId).catch((err: unknown) => {
          this.logger.warn(`llm_ledger_buffer_flush_failed user=${userId} err=${String(err)}`);
        });
      }, FLUSH_INTERVAL_MS);
      // `unref()` so the timer doesn't pin the event loop during tests
      // / graceful shutdown — `onApplicationShutdown` drains explicitly.
      timer.unref();
      this.flushTimerByUser.set(userId, timer);
    }
  }

  async list(userId: string): Promise<readonly UserLlmLedgerEntry[]> {
    const snap = await this.loadSnap(userId);
    const buf = this.bufferByUser.get(userId);
    if (buf === undefined || buf.length === 0) return snap.entries;
    return [...snap.entries, ...buf];
  }

  async summarize(userId: string, since: Date | null = null): Promise<UserLlmLedgerSummary> {
    const sinceIso = since === null ? null : since.toISOString();
    const entries = (await this.list(userId)).filter((e) => sinceIso === null || e.ts >= sinceIso);
    return aggregate(entries);
  }

  /** Public flush — drains the buffer for `userId` and rewrites parquet. */
  async flushNow(userId: string): Promise<void> {
    await this.flushUser(userId);
  }

  /** Flush every buffered user. Called on Nest shutdown. */
  async flushAll(): Promise<void> {
    const userIds = [...this.bufferByUser.keys()];
    await Promise.all(userIds.map((uid) => this.flushUser(uid)));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.flushAll();
  }

  private async flushUser(userId: string): Promise<void> {
    const timer = this.flushTimerByUser.get(userId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.flushTimerByUser.delete(userId);
    }
    const buf = this.bufferByUser.get(userId);
    if (buf === undefined || buf.length === 0) {
      this.bufferByUser.delete(userId);
      return;
    }
    // Detach the batch under the lock so concurrent appends collect into
    // a fresh buffer while we persist.
    const batch = buf;
    this.bufferByUser.set(userId, []);
    await this.mutate(userId, (current) => ({
      schemaVersion: current.schemaVersion,
      entries: [...current.entries, ...batch],
    }));
    // Drop the now-empty buffer entry so the user doesn't linger in the
    // map forever after one call.
    const remaining = this.bufferByUser.get(userId);
    if (remaining !== undefined && remaining.length === 0) {
      this.bufferByUser.delete(userId);
    }
  }

  private async loadSnap(userId: string): Promise<UserLlmLedger> {
    const row = await this.inner.get(userId, SINGLETON_KEY);
    if (row === null) return structuredClone(EMPTY_USER_LLM_LEDGER);
    try {
      const raw = JSON.parse(row.payload_json) as unknown;
      const migrated = migrateLedgerPayload(raw);
      if (migrated !== null) return migrated;
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
  let totalIn = 0;
  let totalOut = 0;
  const byScope = new Map<UserLlmLedgerEntry['scope'], UserLlmLedgerScopeAgg>();
  const byModel = new Map<string, UserLlmLedgerScopeAgg>();
  const accumulate = (
    map: Map<string, UserLlmLedgerScopeAgg>,
    key: string,
    e: UserLlmLedgerEntry,
  ): void => {
    const cur = map.get(key);
    if (cur === undefined) {
      map.set(key, {
        usage: { input: e.usage.input, output: e.usage.output, total: e.usage.total },
        callCount: 1,
      });
    } else {
      map.set(key, {
        usage: {
          input: cur.usage.input + e.usage.input,
          output: cur.usage.output + e.usage.output,
          total: cur.usage.total + e.usage.total,
        },
        callCount: cur.callCount + 1,
      });
    }
  };
  for (const e of entries) {
    totalIn += e.usage.input;
    totalOut += e.usage.output;
    accumulate(byScope as Map<string, UserLlmLedgerScopeAgg>, e.scope, e);
    accumulate(byModel, e.model, e);
  }
  return {
    totalUsage: { input: totalIn, output: totalOut, total: totalIn + totalOut },
    callCount: entries.length,
    byScope: byScope as ReadonlyMap<UserLlmLedgerEntry['scope'], UserLlmLedgerScopeAgg>,
    byModel,
  };
}
