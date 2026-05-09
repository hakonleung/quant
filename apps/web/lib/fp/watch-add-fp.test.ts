import type { WatchCondition } from '@quant/shared';
import { describe, expect, it } from 'vitest';

import {
  buildDraft,
  buildInitialState,
  describeCondition,
  fromCondition,
  INITIAL_CONDITION,
  INITIAL_STATE,
  minuteStringToSeconds,
  NEW_GROUP_SENTINEL,
  secondsToMinuteString,
  toCondition,
  type ConditionDraft,
  type PickedStock,
  type WatchAddInitial,
} from './watch-add-fp.js';

const STOCK: PickedStock = { market: 'a', code: '600519', name: '贵州茅台' };

describe('secondsToMinuteString', () => {
  it('renders whole minutes without trailing zeros', () => {
    expect(secondsToMinuteString(60)).toBe('1');
    expect(secondsToMinuteString(300)).toBe('5');
  });
  it('renders fractional minutes with two decimals', () => {
    expect(secondsToMinuteString(90)).toBe('1.50');
    expect(secondsToMinuteString(45)).toBe('0.75');
  });
  it('handles zero', () => {
    expect(secondsToMinuteString(0)).toBe('0');
  });
});

describe('minuteStringToSeconds', () => {
  it('rounds to the nearest second', () => {
    expect(minuteStringToSeconds('1')).toBe(60);
    expect(minuteStringToSeconds('1.5')).toBe(90);
    expect(minuteStringToSeconds('0.0167')).toBe(1);
  });
  it('returns 0 for empty input (Number("") === 0)', () => {
    expect(minuteStringToSeconds('')).toBe(0);
  });

  it('returns NaN for non-numeric input — caller must validate', () => {
    expect(Number.isNaN(minuteStringToSeconds('abc'))).toBe(true);
  });
});

describe('fromCondition (wire → draft)', () => {
  it('preserves pct fields verbatim', () => {
    const wire: WatchCondition = {
      kind: 'pct',
      baseline: 'prev_close',
      op: 'gte',
      thresholdPct: '5',
    };
    const draft = fromCondition(wire);
    expect(draft.kind).toBe('pct');
    expect(draft.baseline).toBe('prev_close');
    expect(draft.thresholdPct).toBe('5');
    expect(draft.op).toBe('gte');
  });

  it('keeps trend `window` as a stringified seconds value', () => {
    const wire: WatchCondition = {
      kind: 'pct',
      baseline: 'trend',
      op: 'lte',
      thresholdPct: '2',
      window: 120,
    };
    expect(fromCondition(wire).windowSec).toBe('120');
  });

  it('falls back to the 60s default when trend `window` is missing', () => {
    const wire: WatchCondition = { kind: 'pct', baseline: 'trend', op: 'gte', thresholdPct: '1' };
    expect(fromCondition(wire).windowSec).toBe('60');
  });

  it('maps abs to a draft with placeholder pct fields', () => {
    const wire: WatchCondition = { kind: 'abs', op: 'lte', thresholdPrice: '105.5' };
    const draft = fromCondition(wire);
    expect(draft.kind).toBe('abs');
    expect(draft.op).toBe('lte');
    expect(draft.thresholdPrice).toBe('105.5');
  });
});

describe('toCondition (draft → wire)', () => {
  it('emits a pct trend wire shape with clamped window', () => {
    const draft: ConditionDraft = {
      ...INITIAL_CONDITION,
      kind: 'pct',
      baseline: 'trend',
      windowSec: '90',
    };
    const wire = toCondition(draft);
    expect(wire).toEqual({
      kind: 'pct',
      baseline: 'trend',
      op: 'gte',
      thresholdPct: '5',
      window: 90,
    });
  });

  it('clamps trend window to >= 1 second', () => {
    const draft: ConditionDraft = {
      ...INITIAL_CONDITION,
      baseline: 'trend',
      windowSec: '0',
    };
    const wire = toCondition(draft);
    if (wire.kind === 'pct' && wire.baseline === 'trend') {
      expect(wire.window).toBe(1);
    } else {
      throw new Error('expected pct/trend wire');
    }
  });

  it('omits `window` for non-trend pct', () => {
    const draft: ConditionDraft = { ...INITIAL_CONDITION, baseline: 'prev_close' };
    const wire = toCondition(draft);
    expect('window' in wire).toBe(false);
  });

  it('emits an abs wire shape ignoring pct fields', () => {
    const draft: ConditionDraft = { ...INITIAL_CONDITION, kind: 'abs', thresholdPrice: '99.9' };
    expect(toCondition(draft)).toEqual({ kind: 'abs', op: 'gte', thresholdPrice: '99.9' });
  });
});

describe('buildInitialState', () => {
  it('returns the static INITIAL_STATE when no override is given', () => {
    expect(buildInitialState(undefined)).toEqual(INITIAL_STATE);
  });

  it('mirrors picked stocks, conditions, and intervals from the override', () => {
    const initial: WatchAddInitial = {
      picked: [STOCK],
      conditions: [{ kind: 'pct', baseline: 'prev_close', op: 'gte', thresholdPct: '3' }],
      intervalSec: 120,
      pushIntervalSec: 600,
    };
    const state = buildInitialState(initial);
    expect(state.picked).toEqual([STOCK]);
    expect(state.intervalMin).toBe('2');
    expect(state.pushIntervalMin).toBe('10');
    expect(state.mode).toBe('new');
    expect(state.groupSelection).toBe(NEW_GROUP_SENTINEL);
  });

  it('falls back to INITIAL_CONDITION when override has zero conditions', () => {
    const state = buildInitialState({
      picked: [STOCK],
      conditions: [],
      intervalSec: 60,
      pushIntervalSec: 60,
    });
    expect(state.conditions).toEqual([INITIAL_CONDITION]);
  });
});

describe('buildDraft', () => {
  it('parses through the WatchTaskCreate schema', () => {
    const draft = buildDraft(STOCK, 'memeRadar');
    expect(draft.market).toBe('a');
    expect(draft.code).toBe('600519');
    expect(draft.groupName).toBe('memeRadar');
  });
});

describe('describeCondition', () => {
  it('formats pct trend with the window seconds', () => {
    expect(describeCondition({ ...INITIAL_CONDITION, baseline: 'trend', windowSec: '90' })).toBe(
      'pct trend(90s) ≥ 5%',
    );
  });
  it('formats pct non-trend without window', () => {
    expect(describeCondition({ ...INITIAL_CONDITION, baseline: 'prev_close', op: 'lte' })).toBe(
      'pct prev_close ≤ 5%',
    );
  });
  it('formats abs as price-only', () => {
    expect(describeCondition({ ...INITIAL_CONDITION, kind: 'abs', thresholdPrice: '99.9' })).toBe(
      'abs ≥ 99.9',
    );
  });
});
