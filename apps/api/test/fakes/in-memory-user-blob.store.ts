/**
 * Test helper — `UserBlobStore` wired to an `InMemoryUserScopedRecordStore`.
 * Drop-in replacement for tests that previously used per-store
 * filesystem parquets.
 */

import {
  USER_BLOB_TABLE_SPEC,
  UserBlobStore,
  type UserBlobRow,
} from '../../src/common/storage/user-blob.store.js';
import { InMemoryUserScopedRecordStore } from './in-memory-user-scoped-record.store.js';

export interface TestUserBlobStore {
  readonly store: UserBlobStore;
  readonly inner: InMemoryUserScopedRecordStore<UserBlobRow>;
}

export function makeUserBlobStore(): TestUserBlobStore {
  const inner = new InMemoryUserScopedRecordStore<UserBlobRow>(USER_BLOB_TABLE_SPEC);
  const store = new UserBlobStore({
    dataRoot: '/unused',
    inner,
  });
  return { store, inner };
}
