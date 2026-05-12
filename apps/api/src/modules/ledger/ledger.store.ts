/**
 * Per-user ledger store. Each user's entries are rows in a per-user
 * Parquet at `data/users/{userId}/ledger.parquet`, owned by a
 * `UserScopedRecordStore`. The userId is the first parameter of every
 * public method; the controller derives it from `@CurrentUser()`.
 *
 * `closingPosition` is `string | null` in the row schema because the
 * domain DTO allows it to be omitted on derived chain entries; we
 * round-trip `null` ↔ `undefined` at the facade boundary.
 *
 * Self-migration: the underlying store reads legacy
 * `data/users/{userId}/_ledger/entries.json` on first access and
 * renames it `.bak` (CLAUDE.md §9.1 — single onboarding path).
 */

import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  QuantError,
  validateLedger,
  type LedgerEntry,
  type LedgerSnapshot,
} from '@quant/shared';
import { z } from 'zod';

import { FileSystemUserScopedRecordStore } from '../../common/storage/adapters/filesystem-user-scoped-record.store.js';
import type {
  RecordTableSpec,
} from '../../common/storage/ports/record-store.port.js';
import type { UserScopedRecordStore } from '../../common/storage/ports/user-scoped-record-store.port.js';
import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';
import { LEDGER_USER_RECORD_STORE } from './ledger.tokens.js';

export interface LedgerRow {
  readonly date: string;
  readonly pnlAmount: string;
  readonly closingPosition: string | null;
}

export const LedgerRowSchema = z.object({
  date: z.string(),
  pnlAmount: z.string(),
  closingPosition: z.string().nullable(),
});

export const LEDGER_TABLE_SPEC: RecordTableSpec<LedgerRow> = {
  table: 'ledger',
  schema: LedgerRowSchema,
  pk: (row) => row.date,
  columns: [
    { name: 'date', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'pnlAmount', type: 'VARCHAR', nullable: false },
    { name: 'closingPosition', type: 'VARCHAR' },
  ],
};

function decodeLegacyLedger(raw: unknown): readonly LedgerRow[] {
  const snap = raw as { entries?: readonly LedgerEntry[] } | null;
  const entries = snap?.entries ?? [];
  return entries.map((e) => entryToRow(e));
}

function entryToRow(e: LedgerEntry): LedgerRow {
  return {
    date: e.date,
    pnlAmount: e.pnlAmount,
    closingPosition: e.closingPosition ?? null,
  };
}

function rowToEntry(r: LedgerRow): LedgerEntry {
  return r.closingPosition === null
    ? { date: r.date, pnlAmount: r.pnlAmount }
    : { date: r.date, pnlAmount: r.pnlAmount, closingPosition: r.closingPosition };
}

export function buildLedgerUserScopedStore(
  cfg: AuthConfigShape,
  logger: { warn: (m: string) => void; log?: (m: string) => void },
): UserScopedRecordStore<LedgerRow> {
  return new FileSystemUserScopedRecordStore<LedgerRow>({
    dataRoot: cfg.dataRoot,
    spec: LEDGER_TABLE_SPEC,
    legacyJsonPath: (uid) =>
      path.join(cfg.dataRoot, 'users', uid, '_ledger', 'entries.json'),
    legacyDecode: decodeLegacyLedger,
    logger,
  });
}

@Injectable()
export class LedgerStore {
  private readonly logger = new Logger(LedgerStore.name);

  constructor(
    @Inject(LEDGER_USER_RECORD_STORE) private readonly inner: UserScopedRecordStore<LedgerRow>,
    @Inject(AUTH_CONFIG) cfg: AuthConfigShape,
  ) {
    // cfg currently unused but kept in DI signature for forward compat
    // with future per-user pathing knobs.
    void cfg;
    void this.logger;
  }

  async snapshot(userId: string): Promise<LedgerSnapshot> {
    const entries = await this.list(userId);
    return { entries: [...entries] };
  }

  async list(userId: string): Promise<readonly LedgerEntry[]> {
    const rows = await this.inner.list(userId, {
      orderBy: [{ column: 'date', dir: 'asc' }],
    });
    return rows.map((r) => rowToEntry(r));
  }

  async replace(userId: string, entries: readonly LedgerEntry[]): Promise<LedgerSnapshot> {
    const validation = validateLedger(entries);
    if (!validation.ok) {
      throw new QuantError(validation.error.code, validation.error.message);
    }
    // purge then upsert: ledger replace is a full-snapshot operation,
    // so any rows the user removed from the new list must disappear.
    await this.inner.purge(userId);
    if (entries.length > 0) {
      await this.inner.upsertMany(userId, entries.map((e) => entryToRow(e)));
    }
    await this.inner.flush(userId);
    return { entries: [...entries] };
  }

  async flushNow(userId: string): Promise<void> {
    await this.inner.flush(userId);
  }
}
