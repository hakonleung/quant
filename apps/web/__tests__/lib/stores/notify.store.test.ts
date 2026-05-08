import { afterEach, describe, expect, it } from 'vitest';

import { notify, useNotifyStore } from '../../../lib/stores/notify.store.js';

afterEach(() => {
  // Hard reset between tests — zustand stores survive vitest's
  // module cache and would otherwise leak entries across cases.
  useNotifyStore.setState({ entries: [], nextId: 1 });
});

describe('useNotifyStore', () => {
  it('push appends an entry and returns its id', () => {
    const id = useNotifyStore.getState().push({ title: 'hello' });
    expect(id).toBe(1);
    expect(useNotifyStore.getState().entries).toHaveLength(1);
    expect(useNotifyStore.getState().entries[0]?.title).toBe('hello');
  });

  it('default tone is info', () => {
    useNotifyStore.getState().push({ title: 't' });
    expect(useNotifyStore.getState().entries[0]?.tone).toBe('info');
  });

  it('error entries default to a null ttl (pinned)', () => {
    notify.error({ title: 'boom' });
    expect(useNotifyStore.getState().entries[0]?.ttlMs).toBeNull();
  });

  it('non-error entries default to a numeric ttl', () => {
    notify.info({ title: 'a' });
    notify.success({ title: 'b' });
    notify.warn({ title: 'c' });
    const entries = useNotifyStore.getState().entries;
    expect(entries[0]?.ttlMs).toBe(4000);
    expect(entries[1]?.ttlMs).toBe(3000);
    expect(entries[2]?.ttlMs).toBe(6000);
  });

  it('respects an explicit ttl override (including null)', () => {
    notify.info({ title: 'pin', ttlMs: null });
    notify.error({ title: 'flash', ttlMs: 1000 });
    const entries = useNotifyStore.getState().entries;
    expect(entries[0]?.ttlMs).toBeNull();
    expect(entries[1]?.ttlMs).toBe(1000);
  });

  it('dismiss removes by id', () => {
    const id1 = notify.info({ title: 'a' });
    const id2 = notify.info({ title: 'b' });
    useNotifyStore.getState().dismiss(id1);
    const entries = useNotifyStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(id2);
  });

  it('clear empties the queue', () => {
    notify.info({ title: 'a' });
    notify.info({ title: 'b' });
    useNotifyStore.getState().clear();
    expect(useNotifyStore.getState().entries).toEqual([]);
  });

  it('preserves optional code + body fields when set', () => {
    notify.error({ title: 'oops', body: 'detail', code: 'DATA_SOURCE_TIMEOUT' });
    const entry = useNotifyStore.getState().entries[0];
    expect(entry?.body).toBe('detail');
    expect(entry?.code).toBe('DATA_SOURCE_TIMEOUT');
  });

  it('omits optional code + body when not provided (exactOptionalPropertyTypes)', () => {
    notify.info({ title: 'plain' });
    const entry = useNotifyStore.getState().entries[0];
    expect(entry !== undefined && 'body' in entry).toBe(false);
    expect(entry !== undefined && 'code' in entry).toBe(false);
  });

  it('ids are monotonically increasing across pushes', () => {
    const a = notify.info({ title: 'a' });
    const b = notify.info({ title: 'b' });
    const c = notify.info({ title: 'c' });
    expect([a, b, c]).toEqual([1, 2, 3]);
  });
});
