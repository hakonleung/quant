/**
 * UI command engine — local type narrowing of the shared `UiCellBlock`.
 *
 * The shared package (`@quant/shared`) types `scope` as a bare string
 * because it must not depend on the frontend's `Feat` catalogue. Here
 * we narrow `scope` to the actual `Feat` union plus `global` and
 * sub-focus suffix patterns.
 *
 * See `docs/rfcs/0004-ui-cmd-keyboard-engine.md` and `CLAUDE.md` §10.5.
 */

import type { CmdGroup, UiCellBlock, UiCmdCtx } from '@quant/shared';

import { Feat } from '../eqty/feat.js';

export type { CmdGroup, UiCellBlock, UiCmdCtx };

/** A keyboard scope: 'global', a Feat value, or `${Feat}.${sub}`. */
export type Scope = 'global' | Feat | `${Feat}.${string}`;

/** Canonical key token: 'a'..'z', 'A'..'Z', 'Esc', 'Enter', 'Tab', '?'. */
export type KeyToken = string;

/** A parsed key sequence — e.g. ['g','m'] for 'g m', ['D'] for 'D'. */
export type KeySequence = readonly KeyToken[];

/**
 * Alias to the shared context — frontend code treats `activeFeat` and
 * `fullscreen` as `Feat | null` at the storage boundary (the store
 * mutators only accept `Feat`) but the matcher's `when` predicate
 * receives the shared shape (`string | null`) per the `UiCellBlock`
 * contract in `@quant/shared`.
 */
export type UiCtx = UiCmdCtx;

/** A registry binding pairing a cell id with its parsed key sequence. */
export interface UiBinding {
  readonly cellId: string;
  readonly seq: KeySequence;
  readonly ui: UiCellBlock;
}

export const HINT_TOGGLE_CELL_ID = 'ui.hint-toggle';
export const EXIT_FULLSCREEN_CELL_ID = 'ui.exit-fullscreen';
export const CLOSE_MODAL_CELL_ID = 'ui.close-modal';
