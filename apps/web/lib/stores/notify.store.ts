'use client';

/**
 * Lightweight notification queue. Sits between the workbench's error-
 * surfacing layer (LDG mutations, WATCH.LIVE alerts, RPC failures
 * with a `code`) and the floating `feat-notify` toaster.
 *
 * The store is intentionally minimal — no priorities, no grouping,
 * no persistence. The toaster pops the oldest entry first; auto-
 * dismiss is owned by the React component (timeouts can't outlive
 * a tab switch when stored in zustand).
 *
 * `tone` mirrors the existing FeatViewStatus palette so the toast
 * chrome reads as part of the same chrome family — no new color
 * tokens needed.
 *
 * Pure store: no IO, no globals (CLAUDE.md §2.5.1).
 */

import { create } from 'zustand';

import { getClientConfig } from '../config/config-center-next-client-getter.js';

export type NotifyTone = 'info' | 'success' | 'warn' | 'error';

export interface NotifyEntry {
  readonly id: number;
  readonly tone: NotifyTone;
  readonly title: string;
  readonly body?: string;
  /** Optional machine-readable error code (`proto/errors.json`). */
  readonly code?: string;
  /** Auto-dismiss after `ttlMs` ms. `null` keeps the toast pinned
   *  until the user clicks it. */
  readonly ttlMs: number | null;
}

export interface NotifyInput {
  readonly tone?: NotifyTone;
  readonly title: string;
  readonly body?: string;
  readonly code?: string;
  readonly ttlMs?: number | null;
}

function defaultTtlFor(tone: NotifyTone): number | null {
  const notify = getClientConfig().ui.notify;
  switch (tone) {
    case 'info':
      return notify.infoTtlMs;
    case 'success':
      return notify.successTtlMs;
    case 'warn':
      return notify.warnTtlMs;
    case 'error':
      // Errors stay until acknowledged — losing an error message is the
      // worst possible UX outcome.
      return notify.errorTtlMs;
  }
}

interface NotifyState {
  readonly entries: readonly NotifyEntry[];
  readonly nextId: number;
  readonly push: (input: NotifyInput) => number;
  readonly dismiss: (id: number) => void;
  readonly clear: () => void;
}

export const useNotifyStore = create<NotifyState>((set, get) => ({
  entries: [],
  nextId: 1,
  push: (input) => {
    const id = get().nextId;
    const tone = input.tone ?? 'info';
    const ttlMs = input.ttlMs === undefined ? defaultTtlFor(tone) : input.ttlMs;
    set((s) => ({
      entries: [
        ...s.entries,
        {
          id,
          tone,
          title: input.title,
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.code !== undefined ? { code: input.code } : {}),
          ttlMs,
        },
      ],
      nextId: s.nextId + 1,
    }));
    return id;
  },
  dismiss: (id) => {
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
  },
  clear: () => {
    set({ entries: [] });
  },
}));

/**
 * Imperative shortcut for callers that don't have access to the
 * React tree (mutation handlers, query observers, websocket
 * subscriptions). Reads the current store getState so it works
 * outside the React render cycle.
 */
export const notify = {
  info: (input: Omit<NotifyInput, 'tone'>): number =>
    useNotifyStore.getState().push({ ...input, tone: 'info' }),
  success: (input: Omit<NotifyInput, 'tone'>): number =>
    useNotifyStore.getState().push({ ...input, tone: 'success' }),
  warn: (input: Omit<NotifyInput, 'tone'>): number =>
    useNotifyStore.getState().push({ ...input, tone: 'warn' }),
  error: (input: Omit<NotifyInput, 'tone'>): number =>
    useNotifyStore.getState().push({ ...input, tone: 'error' }),
} as const;
