/**
 * Global imperative confirm gate — driven by `useCommand` when a manifest
 * cell carries `doubleConfirm` and dispatch falls through to the BE path.
 *
 * Separate from the per-component `useConfirm` hook (which renders its
 * own dialog and is still used by Feat components for context-rich
 * confirms). This module exists so that `<CmdButton cmd="watch.remove">`
 * outside any Feat can still gate destructive / paid calls.
 */

import { type ReactNode } from 'react';
import { create } from 'zustand';

export interface ConfirmOptions {
  readonly title?: string;
  readonly message: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

export class ConfirmCancelled extends Error {
  constructor() {
    super('confirm cancelled');
    this.name = 'ConfirmCancelled';
  }
}

interface Pending {
  readonly opts: ConfirmOptions;
  readonly resolve: () => void;
  readonly reject: (e: ConfirmCancelled) => void;
}

interface ConfirmState {
  pending: Pending | null;
  openGuard(opts: ConfirmOptions): Promise<void>;
  resolvePending(): void;
  cancelPending(): void;
}

export const useConfirmHubStore = create<ConfirmState>((set, get) => ({
  pending: null,
  openGuard(opts) {
    return new Promise<void>((resolve, reject) => {
      const prev = get().pending;
      if (prev !== null) prev.reject(new ConfirmCancelled());
      set({ pending: { opts, resolve, reject } });
    });
  },
  resolvePending() {
    const p = get().pending;
    if (p === null) return;
    set({ pending: null });
    p.resolve();
  },
  cancelPending() {
    const p = get().pending;
    if (p === null) return;
    set({ pending: null });
    p.reject(new ConfirmCancelled());
  },
}));

/**
 * Imperative entry point — callable from any module without a hook.
 * Resolves on user confirm; rejects with `ConfirmCancelled` on cancel
 * (including when the dialog is superseded by a new guard call).
 */
export function confirmGuard(opts: ConfirmOptions): Promise<void> {
  return useConfirmHubStore.getState().openGuard(opts);
}
