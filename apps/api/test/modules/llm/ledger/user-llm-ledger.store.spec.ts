import {
  USER_LLM_LEDGER_TABLE_SPEC,
  UserLlmLedgerStore,
  type UserLlmLedgerRow,
} from '../../../../src/modules/llm/ledger/user-llm-ledger.store.js';
import {
  EMPTY_USER_LLM_LEDGER,
  USER_LLM_LEDGER_SCHEMA_VERSION,
  migrateLedgerPayload,
  type UserLlmLedgerEntry,
} from '../../../../src/modules/llm/ledger/user-llm-ledger.types.js';
import { InMemoryUserScopedRecordStore } from '../../../fakes/in-memory-user-scoped-record.store.js';

const USER = 'u1';

function makeStore(): {
  store: UserLlmLedgerStore;
  inner: InMemoryUserScopedRecordStore<UserLlmLedgerRow>;
} {
  const inner = new InMemoryUserScopedRecordStore<UserLlmLedgerRow>(
    USER_LLM_LEDGER_TABLE_SPEC,
  );
  const store = new UserLlmLedgerStore(inner);
  return { store, inner };
}

const baseEntry: UserLlmLedgerEntry = {
  ts: '2026-05-15T12:00:00.000Z',
  model: 'kimi-k2.6',
  scope: 'agent',
  usage: { input: 10, output: 20, total: 30 },
  durationMs: 100,
  ok: true,
  traceId: 't1',
};

describe('UserLlmLedgerStore (v2)', () => {
  it('returns empty summary when no entries exist', async () => {
    const { store } = makeStore();
    const s = await store.summarize(USER);
    expect(s.callCount).toBe(0);
    expect(s.totalUsage).toEqual({ input: 0, output: 0, total: 0 });
    expect(s.byScope.size).toBe(0);
    expect(s.byModel.size).toBe(0);
  });

  it('appends and aggregates by scope and model', async () => {
    const { store } = makeStore();
    await store.append(USER, baseEntry);
    await store.append(USER, {
      ...baseEntry,
      ts: '2026-05-15T12:01:00.000Z',
      model: 'qwen-3',
      scope: 'screen',
      usage: { input: 5, output: 5, total: 10 },
    });
    await store.append(USER, {
      ...baseEntry,
      ts: '2026-05-15T12:02:00.000Z',
      usage: { input: 1, output: 2, total: 3 },
    });

    const s = await store.summarize(USER);
    expect(s.callCount).toBe(3);
    expect(s.totalUsage).toEqual({ input: 16, output: 27, total: 43 });

    expect(s.byScope.get('agent')).toEqual({
      usage: { input: 11, output: 22, total: 33 },
      callCount: 2,
    });
    expect(s.byScope.get('screen')).toEqual({
      usage: { input: 5, output: 5, total: 10 },
      callCount: 1,
    });

    expect(s.byModel.get('kimi-k2.6')?.callCount).toBe(2);
    expect(s.byModel.get('qwen-3')?.callCount).toBe(1);
  });

  it('filters by `since`', async () => {
    const { store } = makeStore();
    await store.append(USER, { ...baseEntry, ts: '2026-05-15T08:00:00.000Z' });
    await store.append(USER, { ...baseEntry, ts: '2026-05-15T18:00:00.000Z' });
    const s = await store.summarize(USER, new Date('2026-05-15T12:00:00.000Z'));
    expect(s.callCount).toBe(1);
  });

  it('survives a v1 payload by stripping provider/cnyCost on load', async () => {
    const { store, inner } = makeStore();
    const v1Entry = {
      ts: '2026-05-15T12:00:00.000Z',
      provider: 'moonshot',
      model: 'kimi-k2.6',
      scope: 'agent',
      usage: { input: 10, output: 20, total: 30 },
      cnyCost: 0.1234,
      durationMs: 100,
      ok: true,
      traceId: 't1',
    };
    const v1Payload = { schemaVersion: 1, entries: [v1Entry] };
    await inner.upsert(USER, {
      id: 'singleton',
      payload_json: JSON.stringify(v1Payload),
    });

    const list = await store.list(USER);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('provider');
    expect(list[0]).not.toHaveProperty('cnyCost');
    expect(list[0]?.model).toBe('kimi-k2.6');

    // Mutate forces a rewrite — payload should be v2 now.
    await store.append(USER, baseEntry);
    const row = await inner.get(USER, 'singleton');
    expect(row).not.toBeNull();
    const stored = JSON.parse(row!.payload_json) as { schemaVersion: number };
    expect(stored.schemaVersion).toBe(USER_LLM_LEDGER_SCHEMA_VERSION);
  });

  it('drops malformed entries inside otherwise-valid v1 payload', async () => {
    const { store, inner } = makeStore();
    const v1Payload = {
      schemaVersion: 1,
      entries: [
        { ts: 'bad', provider: 'm', model: 'kimi', scope: 'agent', usage: {}, cnyCost: 0, durationMs: 1, ok: true, traceId: 't' },
        {
          ts: '2026-05-15T12:00:00.000Z',
          provider: 'm',
          model: 'kimi',
          scope: 'agent',
          usage: { input: 1, output: 1, total: 2 },
          cnyCost: 0,
          durationMs: 1,
          ok: true,
          traceId: 't',
        },
      ],
    };
    await inner.upsert(USER, {
      id: 'singleton',
      payload_json: JSON.stringify(v1Payload),
    });
    const list = await store.list(USER);
    expect(list).toHaveLength(1);
  });

  it('returns empty ledger on garbage payload_json', async () => {
    const { store, inner } = makeStore();
    await inner.upsert(USER, { id: 'singleton', payload_json: 'not json' });
    const s = await store.summarize(USER);
    expect(s.callCount).toBe(0);
  });
});

describe('migrateLedgerPayload', () => {
  it('returns null for non-objects', () => {
    expect(migrateLedgerPayload(null)).toBeNull();
    expect(migrateLedgerPayload('x')).toBeNull();
    expect(migrateLedgerPayload(42)).toBeNull();
  });

  it('returns null when entries is missing', () => {
    expect(migrateLedgerPayload({ schemaVersion: 1 })).toBeNull();
  });

  it('produces empty v2 payload from empty v1 input', () => {
    const out = migrateLedgerPayload({ schemaVersion: 1, entries: [] });
    expect(out).toEqual(EMPTY_USER_LLM_LEDGER);
  });

  it('passes v2 entries through unchanged', () => {
    const v2 = { schemaVersion: 2, entries: [baseEntry] };
    const out = migrateLedgerPayload(v2);
    expect(out?.schemaVersion).toBe(USER_LLM_LEDGER_SCHEMA_VERSION);
    expect(out?.entries).toEqual([baseEntry]);
  });
});
