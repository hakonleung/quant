import { afterEach, describe, expect, it } from 'vitest';

import {
  confirmGuard,
  ConfirmCancelled,
  useConfirmHubStore,
} from './store.js';

afterEach(() => useConfirmHubStore.setState({ pending: null }));

describe('confirmGuard', () => {
  it('resolves when resolvePending is called', async () => {
    const promise = confirmGuard({ message: 'go?' });
    expect(useConfirmHubStore.getState().pending).not.toBeNull();
    useConfirmHubStore.getState().resolvePending();
    await expect(promise).resolves.toBeUndefined();
    expect(useConfirmHubStore.getState().pending).toBeNull();
  });

  it('rejects with ConfirmCancelled when cancelPending is called', async () => {
    const promise = confirmGuard({ message: 'go?' });
    useConfirmHubStore.getState().cancelPending();
    await expect(promise).rejects.toBeInstanceOf(ConfirmCancelled);
  });

  it('superseding guard cancels the previous one', async () => {
    const first = confirmGuard({ message: 'first' });
    const second = confirmGuard({ message: 'second' });
    await expect(first).rejects.toBeInstanceOf(ConfirmCancelled);
    expect(useConfirmHubStore.getState().pending?.opts.message).toBe('second');
    useConfirmHubStore.getState().resolvePending();
    await expect(second).resolves.toBeUndefined();
  });

  it('resolve / cancel with no pending is a no-op', () => {
    useConfirmHubStore.getState().resolvePending();
    useConfirmHubStore.getState().cancelPending();
    expect(useConfirmHubStore.getState().pending).toBeNull();
  });
});
