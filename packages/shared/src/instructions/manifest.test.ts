/**
 * Unit tests for the cross-process command manifest. Covers:
 *   - lookups by id
 *   - per-side filtering
 *   - assertHandlerCoverage (golden + every error path)
 */

import { describe, expect, it } from 'vitest';

import {
  COMMAND_MANIFEST,
  assertHandlerCoverage,
  commandsSupportedOn,
  getCommandManifestEntry,
} from './manifest.js';

describe('COMMAND_MANIFEST', () => {
  it('contains every known instruction id with no duplicates', () => {
    const ids = COMMAND_MANIFEST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares supportedOn as a non-empty subset of {fe, be} for every entry', () => {
    for (const e of COMMAND_MANIFEST) {
      expect(e.supportedOn.length).toBeGreaterThan(0);
      for (const s of e.supportedOn) expect(['fe', 'be']).toContain(s);
    }
  });
});

describe('getCommandManifestEntry', () => {
  it('returns the entry for a known id', () => {
    const e = getCommandManifestEntry('watch');
    expect(e?.group).toBe('watch');
    expect(e?.supportedOn).toContain('be');
    expect(e?.supportedOn).toContain('fe');
  });

  it('returns undefined for an unknown id', () => {
    expect(getCommandManifestEntry('does-not-exist')).toBeUndefined();
  });
});

describe('commandsSupportedOn', () => {
  it('returns only entries that include the requested side', () => {
    const fe = commandsSupportedOn('fe');
    const be = commandsSupportedOn('be');
    for (const e of fe) expect(e.supportedOn).toContain('fe');
    for (const e of be) expect(e.supportedOn).toContain('be');
  });

  it('FE-only commands appear in fe but not be', () => {
    const fe = commandsSupportedOn('fe').map((e) => e.id);
    const be = commandsSupportedOn('be').map((e) => e.id);
    expect(fe).toContain('clear');
    expect(be).not.toContain('clear');
  });

  it('BE-only commands appear in be but not fe', () => {
    const fe = commandsSupportedOn('fe').map((e) => e.id);
    const be = commandsSupportedOn('be').map((e) => e.id);
    expect(be).toContain('ping');
    expect(fe).not.toContain('ping');
  });
});

describe('assertHandlerCoverage', () => {
  it('passes when every BE-supported entry is registered', () => {
    const ids = commandsSupportedOn('be').map((e) => e.id);
    expect(() => assertHandlerCoverage({ side: 'be', registeredIds: ids })).not.toThrow();
  });

  it('throws when an expected handler is missing', () => {
    const ids = commandsSupportedOn('be').map((e) => e.id).filter((id) => id !== 'sector.show');
    expect(() => assertHandlerCoverage({ side: 'be', registeredIds: ids })).toThrow(
      /missing on be: sector\.show/,
    );
  });

  it('treats conditionallyRegistered manifest entries as optional', () => {
    // ping is conditionallyRegistered (debug-gated). Coverage must
    // pass whether or not it's registered.
    const without = commandsSupportedOn('be')
      .filter((e) => e.conditionallyRegistered !== true)
      .map((e) => e.id);
    expect(() => assertHandlerCoverage({ side: 'be', registeredIds: without })).not.toThrow();
    expect(() =>
      assertHandlerCoverage({ side: 'be', registeredIds: [...without, 'ping'] }),
    ).not.toThrow();
  });

  it('throws when a registered id is not in the manifest', () => {
    const ids = [...commandsSupportedOn('be').map((e) => e.id), 'ghost.command'];
    expect(() => assertHandlerCoverage({ side: 'be', registeredIds: ids })).toThrow(
      /unexpected on be: ghost\.command \(not in manifest\)/,
    );
  });

  it('throws when a registered id exists in manifest but not for this side', () => {
    const ids = [...commandsSupportedOn('be').map((e) => e.id), 'clear'];
    expect(() => assertHandlerCoverage({ side: 'be', registeredIds: ids })).toThrow(
      /unexpected on be: clear \(manifest says supportedOn=fe\)/,
    );
  });

  it('reports both missing and stray ids together', () => {
    const ids = commandsSupportedOn('be')
      .map((e) => e.id)
      .filter((id) => id !== 'sector.show')
      .concat(['ghost']);
    expect(() => assertHandlerCoverage({ side: 'be', registeredIds: ids })).toThrow(/missing.*unexpected/);
  });
});
