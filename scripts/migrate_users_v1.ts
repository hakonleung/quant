/**
 * One-shot migration: relocate legacy single-user files into the new
 * per-user directory layout under `data/users/admin/`.
 *
 *   data/_ledger/entries.json     → data/users/admin/_ledger/entries.json
 *   data/_ledger/ai-cache.json    → data/users/admin/_ledger/ai-cache.json
 *   data/watch/tasks.json         → data/users/admin/watch/tasks.json
 *   data/watch/groups.json        → data/users/admin/watch/groups.json
 *   data/sys-cfg/sys-cfg.json     → data/users/admin/sys-cfg/sys-cfg.json
 *
 * Idempotent: if `data/users/admin/` already exists the script exits 0
 * without touching anything. Shared market caches (kline / sectors /
 * blacklist / sentiment / ta / meta / watch universe) are untouched.
 *
 * Run:  pnpm tsx scripts/migrate_users_v1.ts
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

interface MigrationEntry {
  readonly from: string;
  readonly to: string;
}

const ENTRIES: readonly MigrationEntry[] = [
  { from: '_ledger/entries.json', to: 'users/admin/_ledger/entries.json' },
  { from: '_ledger/ai-cache.json', to: 'users/admin/_ledger/ai-cache.json' },
  { from: 'watch/tasks.json', to: 'users/admin/watch/tasks.json' },
  { from: 'watch/groups.json', to: 'users/admin/watch/groups.json' },
  { from: 'sys-cfg/sys-cfg.json', to: 'users/admin/sys-cfg/sys-cfg.json' },
];

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const dataRoot = process.env['QUANT_DATA_ROOT'] ?? path.resolve(process.cwd(), 'data');
  const adminDir = path.join(dataRoot, 'users', 'admin');
  const adminAlreadyExists = await exists(adminDir);
  if (adminAlreadyExists) {
    console.log(`[migrate_users_v1] ${adminDir} already exists, nothing to do`);
    return;
  }

  let moved = 0;
  for (const entry of ENTRIES) {
    const src = path.join(dataRoot, entry.from);
    const dst = path.join(dataRoot, entry.to);
    if (!(await exists(src))) {
      console.log(`[migrate_users_v1] skip ${entry.from} (absent)`);
      continue;
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    moved += 1;
    console.log(`[migrate_users_v1] mv ${entry.from} → ${entry.to}`);
  }

  await seedAdminUser(dataRoot);
  console.log(`[migrate_users_v1] done — ${String(moved)} file(s) moved`);
}

async function seedAdminUser(dataRoot: string): Promise<void> {
  const file = path.join(dataRoot, 'users', '_meta', 'users.json');
  if (await exists(file)) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  const payload = {
    users: [
      {
        id: 'admin',
        provider: 'admin',
        externalId: 'admin',
        tenantKey: null,
        displayName: 'admin',
        email: null,
        avatarUrl: null,
        createdAt: now,
        lastLoginAt: now,
      },
    ],
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[migrate_users_v1] seeded users/_meta/users.json`);
}

main().catch((err: unknown) => {
  console.error('[migrate_users_v1] failed:', err);
  process.exit(1);
});
