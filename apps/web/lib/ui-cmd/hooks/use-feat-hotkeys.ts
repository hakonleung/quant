'use client';

/**
 * Hook for Feat components to register their cell handlers.
 *
 * Usage:
 *   useFeatHotkeys(Feat.Mkt, {
 *     'sector.show': (args) => { ... },
 *     'sector.rm': (args) => { ... },
 *   });
 *
 * On mount, binds each handler to `uiRegistry`. On unmount, unbinds.
 * Throws in dev when a passed cellId either doesn't exist or has a scope
 * that does not match `feat` (or `${feat}.*`) — surfaces wiring drift early.
 */

import { useEffect } from 'react';

import type { Feat } from '../../eqty/feat.js';
import { uiRegistry } from '../registry.js';

type Handler = (args?: unknown) => void | Promise<void>;
export type FeatHandlerMap = Readonly<Record<string, Handler>>;

export function useFeatHotkeys(feat: Feat, handlers: FeatHandlerMap): void {
  useEffect(() => {
    const unbinds: Array<() => void> = [];
    for (const [cellId, fn] of Object.entries(handlers)) {
      assertScopeMatches(feat, cellId);
      unbinds.push(uiRegistry.bind(cellId, fn));
    }
    return (): void => {
      for (const u of unbinds) u();
    };
  }, [feat, handlers]);
}

function assertScopeMatches(feat: Feat, cellId: string): void {
  const ui = uiRegistry.getUiBlock(cellId);
  if (ui === undefined) {
    throw new Error(`useFeatHotkeys: unknown cell or no ui block: "${cellId}"`);
  }
  const scope = ui.scope;
  if (scope !== feat && !scope.startsWith(`${feat}.`)) {
    throw new Error(
      `useFeatHotkeys: cell "${cellId}" scope "${scope}" does not match feat "${feat}"`,
    );
  }
}
