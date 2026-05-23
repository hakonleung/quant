'use client';

import { useShallow } from 'zustand/react/shallow';

import { useFocusStore } from '../store/focus.js';
import type { UiCtx } from '../types.js';

/** Subscribe to the keyboard engine's UI context. */
export function useActiveScope(): UiCtx {
  return useFocusStore(
    useShallow(
      (s): UiCtx => ({
        activeFeat: s.activeFeat,
        fullscreen: s.fullscreen,
        subFocus: s.subFocus,
        modalOpen: s.modalOpen,
        hintOpen: s.hintOpen,
      }),
    ),
  );
}
