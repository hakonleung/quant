'use client';

/**
 * Returns a stable dispatch function for the named cell.
 *
 * Routing rules:
 *   1. If a local handler has been bound via `useFeatHotkeys` (or
 *      `installGlobalCells`), call it. This preserves the keyboard /
 *      mouse parity contract — both reach the same component-owned
 *      handler.
 *   2. Otherwise, fall through to `invokeInstruction(cellId, args)` —
 *      the HTTP route every Terminal command uses. On a successful
 *      envelope the manifest's `revalidate` scopes fan out through the
 *      QueryClient + the sector store. On `{ ok: false }` the returned
 *      promise rejects with an `Error` carrying the envelope's code +
 *      message.
 *
 * Buttons for cells whose `doubleConfirm` is set must pass
 * `args.confirm = true` (or wrap the click in their own `useConfirm`
 * guard, like the legacy Feat code does today). Centralising the
 * confirm-gate is deferred to a follow-up.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  COMMAND_MANIFEST,
  type CommandManifestEntry,
} from '@quant/shared';

import { invokeInstruction } from '../../instructions/client.js';
import { createRevalidate } from '../../term/revalidate.js';
import { confirmGuard, ConfirmCancelled } from '../confirm/store.js';
import { uiRegistry } from '../registry.js';

export function useCommand(cellId: string): (args?: unknown) => Promise<void> {
  const qc = useQueryClient();
  return useCallback(
    async (args?: unknown): Promise<void> => {
      if (uiRegistry.hasHandler(cellId)) {
        await uiRegistry.dispatch(cellId, args);
        return;
      }
      const entry = manifestEntry(cellId);
      if (entry === undefined) {
        throw new Error(`useCommand: unknown cellId "${cellId}"`);
      }
      const argsObj = (args ?? {}) as Record<string, unknown>;
      // Auto-fire confirm gate when the manifest declares it and the
      // caller has not already short-circuited via `args.confirm`. On
      // cancel, return silently so the click is a no-op (matches how
      // existing Feat code with useConfirm behaves).
      if (entry.doubleConfirm !== undefined && argsObj['confirm'] !== true) {
        try {
          await confirmGuard({
            title: entry.summary.toLowerCase(),
            message:
              entry.doubleConfirm === 'destructive'
                ? `${entry.summary}? this cannot be undone.`
                : `${entry.summary}? this triggers a paid LLM call.`,
            confirmLabel:
              entry.doubleConfirm === 'destructive' ? 'CONFIRM' : 'PROCEED',
          });
        } catch (e: unknown) {
          if (e instanceof ConfirmCancelled) return;
          throw e;
        }
        argsObj['confirm'] = true;
      }
      const envelope = await invokeInstruction(
        cellId as never,
        argsObj as never,
      );
      if (!envelope.ok) {
        throw new Error(
          `dispatch ${cellId} failed: ${envelope.error.code}: ${envelope.error.message}`,
        );
      }
      const scopes = entry.revalidate ?? [];
      if (scopes.length > 0) {
        const revalidate = createRevalidate(qc);
        for (const scope of scopes) revalidate(scope);
      }
    },
    [cellId, qc],
  );
}

function manifestEntry(id: string): CommandManifestEntry | undefined {
  return COMMAND_MANIFEST.find((e) => e.id === id);
}
