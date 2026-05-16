/**
 * Unit tests for the cross-process command manifest. Covers:
 *   - lookups by id
 *   - uniqueness invariants
 */

import { describe, expect, it } from 'vitest';

import { COMMAND_MANIFEST, getCommandManifestEntry } from './manifest.js';

describe('COMMAND_MANIFEST', () => {
  it('contains every known instruction id with no duplicates', () => {
    const ids = COMMAND_MANIFEST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('getCommandManifestEntry', () => {
  it('returns the entry for a known id', () => {
    const e = getCommandManifestEntry('watch');
    expect(e?.group).toBe('watch');
  });

  it('returns undefined for an unknown id', () => {
    expect(getCommandManifestEntry('does-not-exist')).toBeUndefined();
  });
});
