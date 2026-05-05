import { describe, expect, it } from 'vitest';
import {
  ALL_ACTIONS,
  findAction,
  listActions,
} from '../actions/registry.js';

describe('action registry', () => {
  it('exposes 15 unique action ids (golden)', () => {
    const ids = ALL_ACTIONS.map((a) => a.id);
    expect(ids.length).toBe(15);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('findAction returns matching config', () => {
    const cfg = findAction('stock.info');
    expect(cfg).toBeDefined();
    expect(cfg?.kind).toBe('read');
  });

  it('findAction returns undefined for unknown id', () => {
    expect(findAction('nope')).toBeUndefined();
  });

  it('listActions matches ALL_ACTIONS length', () => {
    expect(listActions().length).toBe(ALL_ACTIONS.length);
  });

  it('every read action declares cacheKey', () => {
    for (const a of ALL_ACTIONS) {
      if (a.kind === 'read') {
        expect(a.cacheKey).toBeDefined();
      }
    }
  });

  it('every write/paid action declares invalidates', () => {
    for (const a of ALL_ACTIONS) {
      if (a.kind === 'write' || (a.kind === 'paid' && a.id !== 'screen.nl')) {
        expect(a.invalidates).toBeDefined();
      }
    }
  });
});
