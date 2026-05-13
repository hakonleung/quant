/**
 * Smoke test for `scripts/verify-storage-migration.ts`. Sets up a
 * mini `data/` tree with one of each migrated store's `.bak` + parquet
 * pair, runs the script as a child process, and asserts the report
 * comes back PASS. A second variant deliberately corrupts a parquet
 * to confirm the FAIL path also surfaces.
 *
 * The store modules themselves own the round-trip behaviour; this spec
 * just guards the script's wiring + report contract.
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'verify-storage-migration.ts');

async function makeDataRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'verify-migration-'));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value));
}

async function writeBlacklistParquet(dataRoot: string, codes: readonly string[]): Promise<void> {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  const target = join(dataRoot, 'blacklist.parquet');
  await conn.run(`
    COPY (
      SELECT
        'singleton' AS id,
        '${JSON.stringify(codes).replace(/'/g, "''")}' AS codes_json,
        '2026-05-04' AS asof,
        5500 AS "universeSize",
        '2026-05-04T07:15:00.000Z' AS "computedAt"
    ) TO '${target}' (FORMAT PARQUET);
  `);
  conn.disconnectSync();
}

function runScript(dataRoot: string): { stdout: string; status: number | null } {
  const result = spawnSync('pnpm', ['tsx', SCRIPT, '--data-root', dataRoot], {
    cwd: join(__dirname, '..', '..'),
    encoding: 'utf8',
  });
  return { stdout: `${result.stdout}\n${result.stderr}`, status: result.status };
}

describe('verify-storage-migration script', () => {
  it('reports PASS when a blacklist .bak matches the parquet', async () => {
    const root = await makeDataRoot();
    try {
      const codes = ['000001', '600519'];
      const snapshot = {
        codes,
        asof: '2026-05-04',
        universeSize: 5500,
        computedAt: '2026-05-04T07:15:00.000Z',
      };
      await writeJson(join(root, 'blacklist.json.bak'), snapshot);
      await writeBlacklistParquet(root, codes);

      const out = runScript(root);
      expect(out.status).toBe(0);
      expect(out.stdout).toContain('Status: PASS');
      expect(out.stdout).toContain('✓ `blacklist`');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports FAIL when blacklist parquet drifts from the legacy', async () => {
    const root = await makeDataRoot();
    try {
      await writeJson(join(root, 'blacklist.json.bak'), {
        codes: ['000001', '600519'],
        asof: '2026-05-04',
        universeSize: 5500,
        computedAt: '2026-05-04T07:15:00.000Z',
      });
      await writeBlacklistParquet(root, ['000001']); // parquet is missing one

      const out = runScript(root);
      expect(out.status).toBe(1);
      expect(out.stdout).toContain('Status: FAIL');
      expect(out.stdout).toContain('codes mismatch');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('exits 0 with zero checks when no .bak files exist', async () => {
    const root = await makeDataRoot();
    try {
      const out = runScript(root);
      expect(out.status).toBe(0);
      expect(out.stdout).toContain('checks run: 0');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
