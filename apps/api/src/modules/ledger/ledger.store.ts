/**
 * Per-user ledger facade. Reads/writes the `ledger.entries` slice of
 * the consolidated `data/users/{uid}/user.parquet` via `UserBlobStore`.
 *
 * `replace` is a full-snapshot operation (matches the previous
 * implementation's purge-then-upsert semantics): callers always send
 * the complete entry list. Domain validation runs through
 * `validateLedger` before the slice is committed.
 */

import { Inject, Injectable } from '@nestjs/common';
import { QuantError, validateLedger, type LedgerEntry, type LedgerSnapshot } from '@quant/shared';

import { UserBlobStore } from '../../common/storage/user-blob.store.js';

@Injectable()
export class LedgerStore {
  constructor(@Inject(UserBlobStore) private readonly blob: UserBlobStore) {}

  async snapshot(userId: string): Promise<LedgerSnapshot> {
    const entries = await this.list(userId);
    return { entries: [...entries] };
  }

  async list(userId: string): Promise<readonly LedgerEntry[]> {
    const entries = (await this.blob.read(userId)).ledger.entries;
    return [...entries].sort((a, b) => a.date.localeCompare(b.date));
  }

  async replace(userId: string, entries: readonly LedgerEntry[]): Promise<LedgerSnapshot> {
    const validation = validateLedger(entries);
    if (!validation.ok) {
      throw new QuantError(validation.error.code, validation.error.message);
    }
    const next = await this.blob.update(userId, (b) => ({
      ...b,
      ledger: { entries: [...entries] },
    }));
    return { entries: [...next.ledger.entries] };
  }

  async flushNow(userId: string): Promise<void> {
    await this.blob.flush(userId);
  }
}
