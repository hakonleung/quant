/**
 * Temporary IDB-store export helper for the backend-persistence migration.
 *
 * Exposes ``window.quantExportStores()`` in the browser. Reads every
 * key/value the Zustand `persist` middleware wrote into the `quant-app`
 * IndexedDB DB and downloads the bundle as a single JSON file. The
 * export covers `sectors`, `blacklist`, `settings`, `layout`, `ui`.
 *
 * Remove once the backend `GET /api/sys-cfg/export` endpoint and the
 * sectors/sys-cfg migrations have shipped — this is a one-shot bridge.
 */

'use client';

import { openDB } from 'idb';

const DB_NAME = 'quant-app';
const DB_VERSION = 5;
const STORES = ['sectors', 'blacklist', 'settings', 'layout', 'ui'] as const;

interface ExportBundle {
  readonly schemaVersion: 1;
  readonly exportedAt: string;
  readonly stores: Record<string, Record<string, unknown>>;
}

async function readAllStores(): Promise<ExportBundle> {
  const db = await openDB(DB_NAME, DB_VERSION);
  const stores: Record<string, Record<string, unknown>> = {};
  for (const name of STORES) {
    if (!db.objectStoreNames.contains(name)) {
      stores[name] = {};
      continue;
    }
    const tx = db.transaction(name, 'readonly');
    const keys = await tx.store.getAllKeys();
    const slot: Record<string, unknown> = {};
    for (const key of keys) {
      const raw = await tx.store.get(key);
      const k = String(key);
      slot[k] = typeof raw === 'string' ? safeJsonParse(raw) : raw;
    }
    stores[name] = slot;
  }
  db.close();
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    stores,
  };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function downloadBlob(filename: string, body: string): void {
  const blob = new Blob([body], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function exportStoresToFile(): Promise<ExportBundle> {
  const bundle = await readAllStores();
  const ts = bundle.exportedAt.replace(/[:.]/g, '-');
  downloadBlob(`quant-stores-${ts}.json`, JSON.stringify(bundle, null, 2));
  return bundle;
}

declare global {
  interface Window {
    quantExportStores?: () => Promise<ExportBundle>;
  }
}

export function registerStoreExportGlobal(): void {
  if (typeof window === 'undefined') return;
  window.quantExportStores = exportStoresToFile;
}
