/**
 * Integration test for `scripts/migrate-user-stores.ts`. Builds a
 * synthetic `data/users/{uid}/...` tree containing every legacy file
 * and runs the in-process `runMigration` entry point. Asserts:
 *   - `user.parquet` is written and round-trips back through
 *     `UserBlobStore` to the expected slices.
 *   - `user_llm_ledger.parquet` is rewritten in v2 form (no
 *     `provider` / `cnyCost`).
 *   - Originals are moved into `.legacy/`.
 *   - A second run on the same dir is a no-op.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';

import { runMigration } from '../../scripts/migrate-user-stores.js';
import {
  USER_BLOB_TABLE_SPEC,
  UserBlobStore,
  type UserBlobRow,
} from '../../src/common/storage/user-blob.store.js';
import { FileSystemUserScopedRecordStore } from '../../src/common/storage/adapters/filesystem-user-scoped-record.store.js';
import { DEFAULT_SYS_CFG } from '@quant/shared';

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'migrate-user-stores-'));
}

async function writeSingletonParquet(target: string, payload: unknown): Promise<void> {
  await fs.mkdir(join(target, '..'), { recursive: true });
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  try {
    const escaped = JSON.stringify(payload).replace(/'/g, "''");
    await conn.runAndReadAll(
      `COPY (SELECT 'singleton' AS id, '${escaped}' AS payload_json) TO '${target}' (FORMAT PARQUET)`,
    );
  } finally {
    conn.disconnectSync();
  }
}

async function writeLedgerParquet(
  target: string,
  rows: readonly { date: string; pnlAmount: string; closingPosition: string | null }[],
): Promise<void> {
  await fs.mkdir(join(target, '..'), { recursive: true });
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  try {
    const values = rows
      .map(
        (r) =>
          `('${r.date}', '${r.pnlAmount}', ${
            r.closingPosition === null ? 'NULL' : `'${r.closingPosition}'`
          })`,
      )
      .join(', ');
    await conn.runAndReadAll(
      `COPY (SELECT * FROM (VALUES ${values}) AS t(date, "pnlAmount", "closingPosition")) TO '${target}' (FORMAT PARQUET)`,
    );
  } finally {
    conn.disconnectSync();
  }
}

const USER = 'admin';
const NOW_ISO = '2026-05-15T00:00:00.000Z';

const sampleGroup = {
  name: 'core',
  conditions: [
    { kind: 'pct' as const, baseline: 'prev_close' as const, op: 'gte' as const, thresholdPct: '5' },
  ],
  intervalSec: 20,
  pushIntervalSec: 300,
  enabled: true,
  createdAt: NOW_ISO,
};

const sampleTask = {
  idx: 1,
  market: 'a' as const,
  code: '600000',
  name: '浦发',
  groupName: 'core',
  conditions: [
    { kind: 'pct' as const, baseline: 'prev_close' as const, op: 'gte' as const, thresholdPct: '5' },
  ],
  intervalSec: 20,
  pushIntervalSec: 300,
  remaining: null,
  notifySlack: true,
  enabled: true,
  createdAt: NOW_ISO,
  lastTickAt: null,
  lastPushAt: null,
  lastSampleAt: null,
  hitCount: 0,
  lastHitPrice: null,
};

const sampleSysCfg = { ...DEFAULT_SYS_CFG };

const v1LedgerEntry = {
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

async function readUserBlob(dataRoot: string, userId: string): Promise<unknown> {
  const inner = new FileSystemUserScopedRecordStore<UserBlobRow>({
    dataRoot,
    spec: USER_BLOB_TABLE_SPEC,
    logger: { warn: () => undefined, log: () => undefined },
  });
  const store = new UserBlobStore({ dataRoot, inner });
  return store.read(userId);
}

describe('migrate-user-stores', () => {
  it('migrates all four legacy files into user.parquet and slims the LLM ledger', async () => {
    const root = await tmpRoot();
    const userDir = join(root, 'users', USER);

    await writeSingletonParquet(join(userDir, 'watch_groups.parquet'), [sampleGroup]);
    await writeSingletonParquet(join(userDir, 'watch_tasks.parquet'), {
      version: 2,
      nextIdx: 2,
      tasks: [sampleTask],
    });
    await writeLedgerParquet(join(userDir, 'ledger.parquet'), [
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
      { date: '2026-05-02', pnlAmount: '500', closingPosition: null },
    ]);
    await fs.mkdir(join(userDir, 'sys-cfg'), { recursive: true });
    await fs.writeFile(join(userDir, 'sys-cfg', 'sys-cfg.json'), JSON.stringify(sampleSysCfg));
    await writeSingletonParquet(join(userDir, 'user_llm_ledger.parquet'), {
      schemaVersion: 1,
      entries: [v1LedgerEntry],
    });

    const out = await runMigration({ dataRoot: root, dryRun: false });
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe('migrated');

    // user.parquet exists, round-trips through UserBlobStore to expected shape.
    await expect(fs.stat(join(userDir, 'user.parquet'))).resolves.toBeDefined();
    const blob = (await readUserBlob(root, USER)) as Record<string, unknown>;
    const watch = blob['watch'] as { groups: unknown[]; tasks: { tasks: unknown[]; nextIdx: number } };
    expect(watch.groups).toHaveLength(1);
    expect(watch.tasks.tasks).toHaveLength(1);
    expect(watch.tasks.nextIdx).toBe(2);
    const ledger = blob['ledger'] as { entries: unknown[] };
    expect(ledger.entries).toHaveLength(2);
    expect(blob['sysCfg']).toEqual(sampleSysCfg);

    // Originals moved to .legacy/ — the originals are gone from their
    // canonical paths.
    await expect(fs.access(join(userDir, 'watch_groups.parquet'))).rejects.toBeDefined();
    await expect(fs.access(join(userDir, 'watch_tasks.parquet'))).rejects.toBeDefined();
    await expect(fs.access(join(userDir, 'ledger.parquet'))).rejects.toBeDefined();
    await expect(fs.access(join(userDir, 'sys-cfg', 'sys-cfg.json'))).rejects.toBeDefined();
    await expect(fs.stat(join(userDir, '.legacy', 'watch_groups.parquet'))).resolves.toBeDefined();
    await expect(fs.stat(join(userDir, '.legacy', 'watch_tasks.parquet'))).resolves.toBeDefined();
    await expect(fs.stat(join(userDir, '.legacy', 'ledger.parquet'))).resolves.toBeDefined();
    await expect(
      fs.stat(join(userDir, '.legacy', 'sys-cfg', 'sys-cfg.json')),
    ).resolves.toBeDefined();

    // LLM ledger rewritten — provider + cnyCost dropped.
    const llmInst = await DuckDBInstance.create(':memory:');
    const llmConn = await llmInst.connect();
    try {
      const r = await llmConn.runAndReadAll(
        `SELECT payload_json FROM read_parquet('${join(userDir, 'user_llm_ledger.parquet')}')`,
      );
      const rows = r.getRowObjects() as readonly Record<string, unknown>[];
      const slim = JSON.parse(String(rows[0]!['payload_json'])) as {
        schemaVersion: number;
        entries: Record<string, unknown>[];
      };
      expect(slim.schemaVersion).toBe(2);
      expect(slim.entries).toHaveLength(1);
      expect(slim.entries[0]).not.toHaveProperty('provider');
      expect(slim.entries[0]).not.toHaveProperty('cnyCost');
      expect(slim.entries[0]?.['model']).toBe('kimi-k2.6');
    } finally {
      llmConn.disconnectSync();
    }
  });

  it('is idempotent — re-running on a migrated user is a no-op', async () => {
    const root = await tmpRoot();
    const userDir = join(root, 'users', USER);
    await writeSingletonParquet(join(userDir, 'watch_groups.parquet'), [sampleGroup]);

    const first = await runMigration({ dataRoot: root, dryRun: false });
    expect(first[0]?.status).toBe('migrated');

    const second = await runMigration({ dataRoot: root, dryRun: false });
    expect(second[0]?.status).toBe('already');
    expect(second[0]?.notes.some((n) => n.includes('already in sync'))).toBe(true);
  });

  it('handles a user dir with no legacy files', async () => {
    const root = await tmpRoot();
    await fs.mkdir(join(root, 'users', 'fresh'), { recursive: true });
    const out = await runMigration({ dataRoot: root, dryRun: false });
    expect(out).toHaveLength(1);
    expect(out[0]?.notes.some((n) => n.includes('no legacy files'))).toBe(true);
    await expect(fs.access(join(root, 'users', 'fresh', 'user.parquet'))).rejects.toBeDefined();
  });

  it('dry-run reports what it would do without touching disk', async () => {
    const root = await tmpRoot();
    const userDir = join(root, 'users', USER);
    await writeSingletonParquet(join(userDir, 'watch_groups.parquet'), [sampleGroup]);

    const out = await runMigration({ dataRoot: root, dryRun: true });
    expect(out[0]?.notes.some((n) => n.startsWith('[dry-run]'))).toBe(true);
    await expect(fs.access(join(userDir, 'user.parquet'))).rejects.toBeDefined();
    await expect(fs.access(join(userDir, 'watch_groups.parquet'))).resolves.toBeUndefined();
  });

  it('only-LLM-ledger-needs-rewrite case: leaves user.parquet alone, rewrites llm ledger', async () => {
    const root = await tmpRoot();
    const userDir = join(root, 'users', USER);
    // user.parquet already exists (e.g. lazy migration ran)
    await writeSingletonParquet(join(userDir, 'user.parquet'), {
      schemaVersion: 1,
      watch: { groups: [], tasks: { version: 2, nextIdx: 1, tasks: [] } },
      ledger: { entries: [] },
      sysCfg: sampleSysCfg,
    });
    await writeSingletonParquet(join(userDir, 'user_llm_ledger.parquet'), {
      schemaVersion: 1,
      entries: [v1LedgerEntry],
    });

    const out = await runMigration({ dataRoot: root, dryRun: false });
    expect(out[0]?.notes.some((n) => n.includes('rewrote user_llm_ledger'))).toBe(true);
    expect(out[0]?.notes.some((n) => n.includes('already in sync'))).toBe(true);
  });

  it('handles a user dir with a v2 LLM ledger already (no rewrite)', async () => {
    const root = await tmpRoot();
    const userDir = join(root, 'users', USER);
    await writeSingletonParquet(join(userDir, 'user.parquet'), {
      schemaVersion: 1,
      watch: { groups: [], tasks: { version: 2, nextIdx: 1, tasks: [] } },
      ledger: { entries: [] },
      sysCfg: sampleSysCfg,
    });
    await writeSingletonParquet(join(userDir, 'user_llm_ledger.parquet'), {
      schemaVersion: 2,
      entries: [
        {
          ts: '2026-05-15T12:00:00.000Z',
          model: 'kimi-k2.6',
          scope: 'agent',
          usage: { input: 1, output: 1, total: 2 },
          durationMs: 1,
          ok: true,
          traceId: 't',
        },
      ],
    });

    const out = await runMigration({ dataRoot: root, dryRun: false });
    expect(out[0]?.notes.some((n) => n.includes('already in v2'))).toBe(true);
  });
});
