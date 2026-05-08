/**
 * Pure helpers + form-state types for the WATCH add-form. Extracted
 * from `components/feat-watch-live/watch-add-form.tsx` so the React
 * component stays under the 400-line ceiling (CLAUDE.md §1.2) and so
 * the encoding rules (minutes ↔ seconds, draft ↔ wire) can be unit
 * tested without a DOM.
 *
 * No React, no IO, no side effects — `lib/fp/` is the core-asset
 * boundary (CLAUDE.md §2.5.1) and these helpers must not pull in any
 * adapters or framework hooks.
 */

import {
  WATCH_TREND_WINDOW_MAX_SEC,
  WatchTaskCreateSchema,
  type WatchBaseline,
  type WatchCondition,
  type WatchMarket,
  type WatchTaskCreate,
} from '@quant/shared';

import { z } from 'zod';

export const KindSchema = z.enum(['pct', 'abs']);
export type Kind = z.infer<typeof KindSchema>;
export const OpSchema = z.enum(['gte', 'lte']);
export type Op = z.infer<typeof OpSchema>;

export const KIND_ITEMS = [
  { label: 'pct', value: 'pct' as const },
  { label: 'abs', value: 'abs' as const },
];
export const BASELINE_ITEMS = [
  { label: 'prev_close', value: 'prev_close' as const },
  { label: 'day_high', value: 'day_high' as const },
  { label: 'day_low', value: 'day_low' as const },
  { label: 'vwap', value: 'vwap' as const },
  { label: 'trend', value: 'trend' as const },
];
export const OP_ITEMS = [
  { label: '≥', value: 'gte' as const },
  { label: '≤', value: 'lte' as const },
];

/** Default trend lookback in **seconds** (1 minute). */
export const DEFAULT_TREND_WINDOW_SEC = 60;

export const NEW_GROUP_SENTINEL = '__new__';

export interface PickedStock {
  readonly market: WatchMarket;
  readonly code: string;
  readonly name: string;
}

export interface ConditionDraft {
  readonly kind: Kind;
  readonly baseline: WatchBaseline;
  readonly thresholdPct: string;
  readonly op: Op;
  readonly thresholdPrice: string;
  /** Trend lookback in **seconds**; only used when baseline === 'trend'. */
  readonly windowSec: string;
}

export interface AddFormState {
  readonly picked: readonly PickedStock[];
  readonly conditions: readonly ConditionDraft[];
  /** Display unit on the form is minutes; the wire format is seconds. */
  readonly intervalMin: string;
  /** Same — minutes on form, seconds on wire. */
  readonly pushIntervalMin: string;
  /** Selected group name when mode === 'existing'; ignored when 'new'. */
  readonly groupSelection: string;
  /** New group name typed by the user when mode === 'new'. */
  readonly newGroupName: string;
  readonly mode: 'new' | 'existing';
}

export const INITIAL_CONDITION: ConditionDraft = {
  kind: 'pct',
  baseline: 'prev_close',
  thresholdPct: '5',
  op: 'gte',
  thresholdPrice: '100',
  windowSec: String(DEFAULT_TREND_WINDOW_SEC),
};

export const INITIAL_STATE: AddFormState = {
  picked: [],
  conditions: [INITIAL_CONDITION],
  intervalMin: '1',
  pushIntervalMin: '5',
  groupSelection: NEW_GROUP_SENTINEL,
  newGroupName: '',
  mode: 'new',
};

export function secondsToMinuteString(secs: number): string {
  if (secs % 60 === 0) return String(secs / 60);
  return (secs / 60).toFixed(2);
}

export function minuteStringToSeconds(min: string): number {
  return Math.round(Number(min) * 60);
}

export interface WatchAddInitial {
  readonly picked: readonly PickedStock[];
  readonly conditions: readonly WatchCondition[];
  readonly intervalSec: number;
  readonly pushIntervalSec: number;
}

export function fromCondition(c: WatchCondition): ConditionDraft {
  if (c.kind === 'pct') {
    return {
      kind: 'pct',
      baseline: c.baseline,
      thresholdPct: c.thresholdPct,
      op: c.op,
      thresholdPrice: '100',
      windowSec: c.window === undefined ? String(DEFAULT_TREND_WINDOW_SEC) : String(c.window),
    };
  }
  return {
    kind: 'abs',
    baseline: 'prev_close',
    thresholdPct: '5',
    op: c.op,
    thresholdPrice: c.thresholdPrice,
    windowSec: String(DEFAULT_TREND_WINDOW_SEC),
  };
}

export function buildInitialState(initial: WatchAddInitial | undefined): AddFormState {
  if (!initial) return INITIAL_STATE;
  return {
    picked: initial.picked,
    conditions:
      initial.conditions.length > 0 ? initial.conditions.map(fromCondition) : [INITIAL_CONDITION],
    intervalMin: secondsToMinuteString(initial.intervalSec),
    pushIntervalMin: secondsToMinuteString(initial.pushIntervalSec),
    groupSelection: NEW_GROUP_SENTINEL,
    newGroupName: '',
    mode: 'new',
  };
}

export function toCondition(c: ConditionDraft): WatchCondition {
  if (c.kind === 'pct') {
    if (c.baseline === 'trend') {
      const w = Math.max(
        1,
        Math.min(WATCH_TREND_WINDOW_MAX_SEC, Math.round(Number(c.windowSec) || 0)),
      );
      return {
        kind: 'pct',
        baseline: 'trend',
        op: c.op,
        thresholdPct: c.thresholdPct,
        window: w,
      };
    }
    return { kind: 'pct', baseline: c.baseline, op: c.op, thresholdPct: c.thresholdPct };
  }
  return { kind: 'abs', op: c.op, thresholdPrice: c.thresholdPrice };
}

export function buildDraft(stock: PickedStock, groupName: string): WatchTaskCreate {
  return WatchTaskCreateSchema.parse({
    market: stock.market,
    code: stock.code,
    name: stock.name,
    groupName,
  });
}

/** Human-readable one-line description of a condition draft. Used in
 *  the read-only "existing group" badge to show what the group's
 *  conditions are without the user having to expand them. */
export function describeCondition(c: ConditionDraft): string {
  const op = c.op === 'gte' ? '≥' : '≤';
  if (c.kind === 'pct') {
    if (c.baseline === 'trend') {
      return `pct trend(${c.windowSec}s) ${op} ${c.thresholdPct}%`;
    }
    return `pct ${c.baseline} ${op} ${c.thresholdPct}%`;
  }
  return `abs ${op} ${c.thresholdPrice}`;
}
