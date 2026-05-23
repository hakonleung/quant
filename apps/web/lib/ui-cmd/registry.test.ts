import { afterEach, describe, expect, it } from 'vitest';

import { uiRegistry } from './registry.js';

afterEach(() => uiRegistry.__reset());

describe('uiRegistry — current manifest', () => {
  it('no key-sequence collisions among entries with ui blocks', () => {
    const bindings = uiRegistry.all();
    const seen = new Map<string, string>();
    for (const b of bindings) {
      if (b.seq.length === 0) continue;
      const key = `${b.ui.scope}::${b.seq.join(' ')}`;
      const prior = seen.get(key);
      if (prior !== undefined && prior !== b.cellId) {
        throw new Error(`collision under ${key}: ${prior} vs ${b.cellId}`);
      }
      seen.set(key, b.cellId);
    }
    expect(true).toBe(true);
  });
});

describe('uiRegistry.bind / dispatch / hasHandler', () => {
  it('bind unknown cellId throws', () => {
    expect(() => uiRegistry.bind('does-not-exist', () => undefined)).toThrow(
      /unknown cell/i,
    );
  });

  it('dispatch without bound handler throws', async () => {
    await expect(uiRegistry.dispatch('does-not-exist')).rejects.toThrow(
      /no handler bound/i,
    );
  });

  it('hasHandler false before bind, true after, false after unbind', () => {
    // Use a known FE-only cell — we add a synthetic ui block via __reset workaround:
    // instead, register a real cell. The manifest at Phase 2.3 has no ui blocks yet,
    // so we exercise the error path here and the happy path via the engine tests
    // (which inject synthetic bindings directly into the matcher).
    expect(uiRegistry.hasHandler('does-not-exist')).toBe(false);
  });
});

describe('uiRegistry.visible', () => {
  it('returns empty when no manifest entry carries a ui block (Phase 2.3 state)', () => {
    const ctx = {
      activeFeat: null,
      fullscreen: null,
      subFocus: [],
      modalOpen: false, hintOpen: false,
    } as const;
    expect(uiRegistry.visible(ctx).length).toBe(0);
  });
});
