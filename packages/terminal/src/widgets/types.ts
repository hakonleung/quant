/**
 * Widget public surface — re-exported from the engine state module so widget
 * modules don't have to reach into engine internals.
 */

export type { CommitResolution, InteractiveWidget, KeyHint, WidgetStep } from '../engine/state.js';
export type { KeySpec, SpecialKey } from '../engine/keymap.js';
