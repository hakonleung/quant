/**
 * `/usr` cell — the data fetch + renderer for the user's identity +
 * LLM ledger summary. Replaces the legacy `UsrHandler`.
 *
 * The cell is built via a factory (`buildUsrCell`) that captures the
 * services it needs (auth config, ledger store, clock) at construction
 * time. The center config map then references the cell by id, so the
 * `InstructionCenter.usr` slot is statically declared yet still
 * injection-aware.
 *
 * Handler: pulls today/month/total summaries + by-scope/by-model
 * aggregations and packages them into `UsrResult` (typed data only).
 * Renderer: delegates to `renderUsr` (pure formatting), which converts
 * the envelope to the legacy `InstructionResult` shape consumed by the
 * IM listener.
 */

import type {
  InstructionCell,
  ResultOf,
  UsrLedgerAgg,
  UsrLedgerSnapshot,
} from '@quant/shared';

import { AuthConfig } from '../../auth/config/auth.config.js';
import type { Clock } from '../../../common/clock.js';
import {
  UserLlmLedgerStore,
  type UserLlmLedgerScopeAgg,
  type UserLlmLedgerSummary,
} from '../../llm/ledger/user-llm-ledger.store.js';
import type { BeEnv } from '../be-types.js';
import { renderUsr } from './usr.render.js';

type UsrResult = ResultOf<'usr'>;

export interface UsrCellDeps {
  readonly authCfg: AuthConfig;
  readonly ledger: UserLlmLedgerStore;
  readonly clock: Clock;
}

export function buildUsrCell(deps: UsrCellDeps): InstructionCell<BeEnv, 'usr'> {
  return {
    async handler(_args, ctx): Promise<UsrResult> {
      const identity = buildIdentity(ctx, deps.authCfg.adminUserId);
      const ledger = await collectLedger(deps.ledger, deps.clock, ctx.userId);
      return { identity, ledger };
    },
    renderer(envelope) {
      return renderUsr(envelope);
    },
  };
}

function buildIdentity(
  ctx: { userId: string; channelId?: string; sender?: string; originalUserId?: string; imBootstrap?: boolean },
  adminUserId: string,
): UsrResult['identity'] {
  const role: UsrResult['identity']['role'] = ctx.userId === adminUserId ? 'admin' : 'user';
  const identity: UsrResult['identity'] = {
    userId: ctx.userId,
    role,
    source: 'be',
    ...(ctx.channelId !== undefined ? { channel: ctx.channelId } : {}),
    ...(ctx.sender !== undefined ? { imId: ctx.sender } : {}),
    ...(ctx.originalUserId !== undefined ? { mappedFromUserId: ctx.originalUserId } : {}),
    ...(ctx.imBootstrap === true ? { imBootstrap: true } : {}),
  };
  return identity;
}

async function collectLedger(
  store: UserLlmLedgerStore,
  clock: Clock,
  userId: string,
): Promise<UsrLedgerSnapshot | null> {
  const now = clock.now();
  const startOfTodayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startOfMonthMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const [today, month, total] = await Promise.all([
    store.summarize(userId, new Date(startOfTodayMs)),
    store.summarize(userId, new Date(startOfMonthMs)),
    store.summarize(userId, null),
  ]);
  if (total.callCount === 0) return null;
  return {
    today: aggOfSummary('today', today),
    month: aggOfSummary('month', month),
    total: aggOfSummary('total', total),
    byScope: aggArrayOfMap(total.byScope),
    byModel: aggArrayOfMap(total.byModel),
  };
}

function aggOfSummary(label: string, s: UserLlmLedgerSummary): UsrLedgerAgg {
  return {
    label,
    callCount: s.callCount,
    input: s.totalUsage.input,
    output: s.totalUsage.output,
    total: s.totalUsage.total,
  };
}

function aggArrayOfMap(m: ReadonlyMap<string, UserLlmLedgerScopeAgg>): UsrLedgerAgg[] {
  return Array.from(m.entries())
    .sort((a, b) => b[1].usage.total - a[1].usage.total)
    .map(([label, a]) => ({
      label,
      callCount: a.callCount,
      input: a.usage.input,
      output: a.usage.output,
      total: a.usage.total,
    }));
}
