'use client';

/**
 * React wrapper: mounts a single `keydown` listener on `window` and
 * routes events through the pure engine. Mounted once by `providers.tsx`.
 */

import { useEffect } from 'react';

import { uiRegistry } from '../registry.js';
import { readUiCtx, useFocusStore } from '../store/focus.js';
import { createKeymapEngine } from './keymap-engine.js';

export function UiCmdEngine(): null {
  useEffect(() => {
    const engine = createKeymapEngine({
      getCtx: readUiCtx,
      getBindings: () => uiRegistry.visible(readUiCtx()),
      dispatch: (cellId, args) => uiRegistry.dispatch(cellId, args),
    });
    const onKeyDown = (e: KeyboardEvent): void => engine.handle(e);
    window.addEventListener('keydown', onKeyDown, { capture: true });
    // Dev-only debug surface so manual / E2E checks can read state.
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { __uiCmd?: unknown }).__uiCmd = {
        focus: useFocusStore,
        registry: uiRegistry,
        engine,
      };
    }
    return (): void => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      engine.cancel();
    };
  }, []);
  return null;
}
