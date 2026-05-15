/**
 * Async-write ledger recorder. `LlmService` calls `record(...)` after each
 * LLM call (success or failure); the recorder fires-and-forgets the actual
 * disk write so the call path doesn't block on filesystem latency.
 *
 * Failures are logged at `warn` level — losing one ledger entry is
 * acceptable; failing the user-facing LLM call because the ledger write
 * choked is not.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../common/clock.js';
import { UserLlmLedgerStore } from './user-llm-ledger.store.js';
import type { ChatTokenUsage, LlmScope } from '@quant/shared';

export interface LlmLedgerRecordArgs {
  readonly userId: string;
  readonly model: string;
  readonly scope: LlmScope;
  readonly usage: ChatTokenUsage;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly traceId: string;
}

@Injectable()
export class LlmLedgerRecorder {
  private readonly logger = new Logger(LlmLedgerRecorder.name);

  constructor(
    @Inject(UserLlmLedgerStore) private readonly store: UserLlmLedgerStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  record(args: LlmLedgerRecordArgs): void {
    const ts = this.clock.now().toISOString();
    void this.store
      .append(args.userId, {
        ts,
        model: args.model,
        scope: args.scope,
        usage: args.usage,
        durationMs: args.durationMs,
        ok: args.ok,
        traceId: args.traceId,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `llm_ledger_append_failed userId=${args.userId} model=${args.model} traceId=${args.traceId} err=${String(err)}`,
        );
      });
  }
}
