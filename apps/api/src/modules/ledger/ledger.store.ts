/**
 * Per-user ledger store. Each user's entries persist to
 * `data/users/{userId}/_ledger/entries.json` via `UserScopedJsonStore`.
 * The userId is the first parameter of every public method; the
 * controller derives it from `@CurrentUser()`.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EMPTY_LEDGER,
  LedgerSnapshotSchema,
  QuantError,
  validateLedger,
  type LedgerEntry,
  type LedgerSnapshot,
} from '@quant/shared';

import { UserScopedJsonStore } from '../../common/user-scoped-store.js';
import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';

@Injectable()
export class LedgerStore {
  private readonly logger = new Logger(LedgerStore.name);
  private readonly inner: UserScopedJsonStore<LedgerSnapshot>;

  constructor(@Inject(AUTH_CONFIG) cfg: AuthConfigShape) {
    this.inner = new UserScopedJsonStore<LedgerSnapshot>(cfg.dataRoot, {
      relativePath: (uid) => `users/${uid}/_ledger/entries.json`,
      schema: LedgerSnapshotSchema,
      fallback: () => EMPTY_LEDGER,
      logger: this.logger,
    });
  }

  async snapshot(userId: string): Promise<LedgerSnapshot> {
    return this.inner.snapshot(userId);
  }

  async list(userId: string): Promise<readonly LedgerEntry[]> {
    return (await this.inner.snapshot(userId)).entries;
  }

  /**
   * Replace the user's snapshot atomically. Validates structural
   * invariants before persisting; rejects with a `QuantError` whose
   * `code` maps to the right HTTP status.
   */
  async replace(userId: string, entries: readonly LedgerEntry[]): Promise<LedgerSnapshot> {
    const validation = validateLedger(entries);
    if (!validation.ok) {
      throw new QuantError(validation.error.code, validation.error.message);
    }
    return this.inner.replace(userId, { entries: [...entries] });
  }

  async flushNow(userId: string): Promise<void> {
    await this.inner.flushNow(userId);
  }
}
