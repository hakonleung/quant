import type {
  RecordFilter,
  RecordKey,
  RecordTableSpec,
} from '../../src/common/storage/ports/record-store.port.js';
import type { UserScopedRecordStore } from '../../src/common/storage/ports/user-scoped-record-store.port.js';
import { InMemoryRecordStore } from './in-memory-record.store.js';

export class InMemoryUserScopedRecordStore<
  V,
  K extends RecordKey = string,
> implements UserScopedRecordStore<V, K> {
  private readonly perUser = new Map<string, InMemoryRecordStore<V, K>>();

  constructor(private readonly spec: Pick<RecordTableSpec<V, K>, 'pk'>) {}

  private storeFor(userId: string): InMemoryRecordStore<V, K> {
    let store = this.perUser.get(userId);
    if (store === undefined) {
      store = new InMemoryRecordStore<V, K>(this.spec);
      this.perUser.set(userId, store);
    }
    return store;
  }

  get(userId: string, key: K): Promise<V | null> {
    return this.storeFor(userId).get(key);
  }
  getMany(userId: string, keys: readonly K[]): Promise<readonly V[]> {
    return this.storeFor(userId).getMany(keys);
  }
  list(userId: string, filter?: RecordFilter<V>): Promise<readonly V[]> {
    return this.storeFor(userId).list(filter);
  }
  upsert(userId: string, value: V): Promise<void> {
    return this.storeFor(userId).upsert(value);
  }
  upsertMany(userId: string, values: readonly V[]): Promise<void> {
    return this.storeFor(userId).upsertMany(values);
  }
  delete(userId: string, key: K): Promise<boolean> {
    return this.storeFor(userId).delete(key);
  }
  deleteMany(userId: string, keys: readonly K[]): Promise<number> {
    return this.storeFor(userId).deleteMany(keys);
  }
  count(userId: string, filter?: RecordFilter<V>): Promise<number> {
    return this.storeFor(userId).count(filter);
  }
  async purge(userId: string): Promise<void> {
    this.perUser.delete(userId);
  }
  async flush(): Promise<void> {
    // no-op
  }
}
