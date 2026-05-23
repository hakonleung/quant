'use client';

/**
 * Returns a stable dispatch function for the named cell.
 *
 * Phase 2 PoC: dispatches through `uiRegistry.dispatch`, which calls the
 * handler bound by `useFeatHotkeys` or by global wiring. Phase 3 will
 * route backend-only cells through `feCenter.dispatch` directly so that
 * `<CmdButton cmd="ledger.add" args={...} />` works without a Feat handler.
 */

import { useCallback } from 'react';

import { uiRegistry } from '../registry.js';

export function useCommand(cellId: string): (args?: unknown) => Promise<void> {
  return useCallback(
    async (args?: unknown): Promise<void> => {
      await uiRegistry.dispatch(cellId, args);
    },
    [cellId],
  );
}
