import { describe, expect, it } from 'vitest';

import { COMMAND_MANIFEST } from './manifest.js';
import type { UiCellBlock, UiCmdCtx } from './ui.js';

describe('UiCellBlock — schema reachability', () => {
  it('manifest entries may omit `ui` (backward-compatible)', () => {
    const entries = COMMAND_MANIFEST.filter((e) => e.ui === undefined);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('typed construction with all fields compiles', () => {
    const block: UiCellBlock = {
      scope: 'global',
      keys: ['g m', '?'],
      label: 'Switch to market',
      group: 'nav',
      when: (ctx) => ctx.modalOpen === false,
    };
    expect(block.scope).toBe('global');
    expect(block.keys?.length).toBe(2);
  });

  it('minimal block (no keys, no when) is valid', () => {
    const block: UiCellBlock = {
      scope: 'MKT',
      label: 'Pick stock',
      group: 'action',
    };
    expect(block.keys).toBeUndefined();
    expect(block.when).toBeUndefined();
  });
});

describe('UiCmdCtx — predicate inputs', () => {
  it('default-shaped context is consumable by a when predicate', () => {
    const ctx: UiCmdCtx = {
      activeFeat: null,
      fullscreen: null,
      subFocus: [],
      modalOpen: false,
    };
    const block: UiCellBlock = {
      scope: 'global',
      keys: ['g m'],
      label: 'noop',
      group: 'nav',
      when: (c) => c.activeFeat === null,
    };
    expect(block.when?.(ctx)).toBe(true);
  });

  it('predicate observes fullscreen + subFocus + modalOpen', () => {
    const ctx: UiCmdCtx = {
      activeFeat: 'MKT',
      fullscreen: 'MKT',
      subFocus: ['sector', 'stock'],
      modalOpen: true,
    };
    const block: UiCellBlock = {
      scope: 'MKT.sector',
      keys: ['D'],
      label: 'Delete row',
      group: 'edit',
      when: (c) =>
        c.activeFeat === 'MKT' &&
        c.subFocus.at(-1) === 'stock' &&
        c.fullscreen !== null &&
        c.modalOpen === true,
    };
    expect(block.when?.(ctx)).toBe(true);
  });
});
