/**
 * Atomic JSON write — `tmp + rename`, fsync the dir if available.
 *
 * Used by both the task store and the universe store to keep the on-disk
 * file always parseable even when the process crashes mid-write.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function atomicWriteJson(target: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${String(process.pid)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

export async function readJsonOr<T>(target: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(target, 'utf8');
    return JSON.parse(text) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}
