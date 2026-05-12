import type { KeyValueStore } from '../../src/common/storage/ports/key-value-store.port.js';

interface Entry {
  value: Buffer;
  expiresAt: number | null;
}

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async get(key: string): Promise<Buffer | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: Buffer, ttlSec?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlSec !== undefined ? this.now() + ttlSec * 1000 : null,
    });
  }

  async putIfAbsent(key: string, value: Buffer, ttlSec?: number): Promise<boolean> {
    const existing = await this.get(key);
    if (existing !== null) return false;
    await this.put(key, value, ttlSec);
    return true;
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        n += 1;
      }
    }
    return n;
  }

  async touch(key: string, ttlSec: number): Promise<boolean> {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return false;
    }
    entry.expiresAt = this.now() + ttlSec * 1000;
    return true;
  }
}
