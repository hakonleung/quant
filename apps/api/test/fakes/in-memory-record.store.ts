import type {
  RecordFilter,
  RecordKey,
  RecordStore,
  RecordTableSpec,
} from '../../src/common/storage/ports/record-store.port.js';

export class InMemoryRecordStore<V, K extends RecordKey = string> implements RecordStore<V, K> {
  private readonly rows = new Map<K, V>();

  constructor(private readonly spec: Pick<RecordTableSpec<V, K>, 'pk'>) {}

  async get(key: K): Promise<V | null> {
    return this.rows.get(key) ?? null;
  }

  async getMany(keys: readonly K[]): Promise<readonly V[]> {
    const out: V[] = [];
    for (const k of keys) {
      const v = this.rows.get(k);
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  async list(filter?: RecordFilter<V>): Promise<readonly V[]> {
    let result = Array.from(this.rows.values());
    if (filter?.where !== undefined) {
      const where = filter.where;
      result = result.filter((row) => {
        for (const [col, expected] of Object.entries(where)) {
          if ((row as Record<string, unknown>)[col] !== expected) return false;
        }
        return true;
      });
    }
    if (filter?.whereIn !== undefined) {
      const { column, values } = filter.whereIn;
      const set = new Set<string | number>(values);
      result = result.filter((row) => set.has((row as Record<string, unknown>)[column] as string | number));
    }
    if (filter?.orderBy !== undefined) {
      const orderBy = filter.orderBy;
      result.sort((a, b) => {
        for (const { column, dir } of orderBy) {
          const av = (a as Record<string, unknown>)[column];
          const bv = (b as Record<string, unknown>)[column];
          if (av === bv) continue;
          if (av === null || av === undefined) return dir === 'asc' ? -1 : 1;
          if (bv === null || bv === undefined) return dir === 'asc' ? 1 : -1;
          const cmp = (av as number | string) < (bv as number | string) ? -1 : 1;
          return dir === 'asc' ? cmp : -cmp;
        }
        return 0;
      });
    }
    if (filter?.offset !== undefined) result = result.slice(filter.offset);
    if (filter?.limit !== undefined) result = result.slice(0, filter.limit);
    if (filter?.columns !== undefined) {
      const cols = filter.columns;
      result = result.map((row) => {
        const projected: Record<string, unknown> = {};
        for (const c of cols) projected[c] = (row as Record<string, unknown>)[c];
        return projected as V;
      });
    }
    return result;
  }

  async upsert(value: V): Promise<void> {
    this.rows.set(this.spec.pk(value), value);
  }

  async upsertMany(values: readonly V[]): Promise<void> {
    for (const v of values) this.rows.set(this.spec.pk(v), v);
  }

  async delete(key: K): Promise<boolean> {
    return this.rows.delete(key);
  }

  async deleteMany(keys: readonly K[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.rows.delete(k)) n += 1;
    return n;
  }

  async count(filter?: RecordFilter<V>): Promise<number> {
    if (filter === undefined) return this.rows.size;
    return (await this.list(filter)).length;
  }

  async flush(): Promise<void> {
    // no-op
  }
}
