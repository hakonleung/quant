/**
 * Tests for the /usr cell handler. Covers:
 *   - admin vs user role mapping via AuthConfig.adminUserId
 *   - ledger snapshot built from today/month/total + byScope/byModel
 *   - null ledger when no calls recorded
 *   - mapped-from / imBootstrap / channel / sender pass through
 */

import { FrozenClock } from '../../../src/common/clock.js';
import type { AuthConfig } from '../../../src/modules/auth/config/auth.config.js';
import { buildUsrCell } from '../../../src/modules/instruction-center/cells/usr.cell.js';
import type {
  UserLlmLedgerScopeAgg,
  UserLlmLedgerStore,
  UserLlmLedgerSummary,
} from '../../../src/modules/llm/ledger/user-llm-ledger.store.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

// eslint-disable-next-line no-restricted-globals
const NOW = new Date('2026-05-16T03:00:00.000Z');

function emptySummary(): UserLlmLedgerSummary {
  return {
    totalUsage: { input: 0, output: 0, total: 0 },
    callCount: 0,
    byScope: new Map(),
    byModel: new Map(),
  };
}

function summary(input: number, output: number, callCount: number): UserLlmLedgerSummary {
  const scope = new Map<UserLlmLedgerSummary['byScope'] extends ReadonlyMap<infer K, infer _V> ? K : never, UserLlmLedgerScopeAgg>();
  scope.set('agent', { callCount, usage: { input, output, total: input + output } });
  const model = new Map<string, UserLlmLedgerScopeAgg>();
  model.set('gpt-4o', { callCount, usage: { input, output, total: input + output } });
  return {
    totalUsage: { input, output, total: input + output },
    callCount,
    byScope: scope,
    byModel: model,
  };
}

interface FakeLedgerOpts {
  readonly today?: UserLlmLedgerSummary;
  readonly month?: UserLlmLedgerSummary;
  readonly total?: UserLlmLedgerSummary;
}

function fakeLedger(opts: FakeLedgerOpts = {}): UserLlmLedgerStore {
  // Order of summarize calls in buildUsrCell: today, month, total.
  const calls: UserLlmLedgerSummary[] = [
    opts.today ?? emptySummary(),
    opts.month ?? emptySummary(),
    opts.total ?? emptySummary(),
  ];
  let i = 0;
  return {
    summarize: () => {
      const r = calls[i] ?? emptySummary();
      i += 1;
      return Promise.resolve(r);
    },
  } as unknown as UserLlmLedgerStore;
}

const authCfg = { adminUserId: 'admin' } as unknown as AuthConfig;

const ctxBase: InstructionCtx = {
  traceId: 't1',
  source: 'im',
  userId: 'admin',
};

describe('buildUsrCell.handler', () => {
  it('marks the caller as admin when userId matches AuthConfig.adminUserId', async () => {
    const cell = buildUsrCell({ authCfg, ledger: fakeLedger(), clock: new FrozenClock(NOW) });
    const r = await cell.handler({}, ctxBase);
    expect(r.identity.role).toBe('admin');
    expect(r.identity.userId).toBe('admin');
  });

  it('marks non-admin callers as user', async () => {
    const cell = buildUsrCell({ authCfg, ledger: fakeLedger(), clock: new FrozenClock(NOW) });
    const r = await cell.handler({}, { ...ctxBase, userId: 'someone-else' });
    expect(r.identity.role).toBe('user');
  });

  it('returns ledger=null when no calls recorded', async () => {
    const cell = buildUsrCell({ authCfg, ledger: fakeLedger(), clock: new FrozenClock(NOW) });
    const r = await cell.handler({}, ctxBase);
    expect(r.ledger).toBeNull();
  });

  it('builds today/month/total + byScope + byModel aggregates when calls exist', async () => {
    const cell = buildUsrCell({
      authCfg,
      ledger: fakeLedger({
        today: summary(10, 20, 1),
        month: summary(30, 60, 3),
        total: summary(50, 100, 5),
      }),
      clock: new FrozenClock(NOW),
    });
    const r = await cell.handler({}, ctxBase);
    expect(r.ledger).not.toBeNull();
    if (r.ledger === null) return;
    expect(r.ledger.today).toEqual({
      label: 'today',
      callCount: 1,
      input: 10,
      output: 20,
      total: 30,
    });
    expect(r.ledger.month.callCount).toBe(3);
    expect(r.ledger.total.callCount).toBe(5);
    expect(r.ledger.byScope[0]?.label).toBe('agent');
    expect(r.ledger.byModel[0]?.label).toBe('gpt-4o');
  });

  it('passes through optional ctx fields onto identity', async () => {
    const cell = buildUsrCell({ authCfg, ledger: fakeLedger(), clock: new FrozenClock(NOW) });
    const r = await cell.handler(
      {},
      {
        ...ctxBase,
        channelId: 'feishu',
        sender: 'feishu:user-x',
        originalUserId: 'feishu:user-x',
        imBootstrap: true,
      },
    );
    expect(r.identity.channel).toBe('feishu');
    expect(r.identity.imId).toBe('feishu:user-x');
    expect(r.identity.mappedFromUserId).toBe('feishu:user-x');
    expect(r.identity.imBootstrap).toBe(true);
  });
});
