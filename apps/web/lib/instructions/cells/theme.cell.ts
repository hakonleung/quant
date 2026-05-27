/**
 * FE `/theme` cell — flip the workbench theme.
 *
 * Pure-FE: writes to `useSettingsStore.setTheme`, which mirrors the
 * change to `localStorage('qx-theme')` and the `<html>` class so xterm
 * + every theme-aware token resolves to the new palette without a
 * reload.
 */

import { type InstructionCell, type ResultOf } from '@quant/shared';
import { textOk } from '@quant/terminal';

import { useSettingsStore } from '../../stores/settings.store.js';
import type { FeEnv } from '../fe-types.js';

type ThemeResult = ResultOf<'theme'>;

export function buildThemeCell(): InstructionCell<FeEnv, 'theme'> {
  return {
    async handler(args): Promise<ThemeResult> {
      const store = useSettingsStore.getState();
      const previous = store.theme;
      const next =
        args.mode === undefined || args.mode === 'toggle'
          ? previous === 'dark'
            ? 'light'
            : 'dark'
          : args.mode;
      if (next !== previous) store.setTheme(next);
      return { previous, current: next };
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return {
          kind: 'text',
          status: 'err',
          tail: { body: `${envelope.error.code}: ${envelope.error.message}` },
        };
      }
      const { previous, current } = envelope.data;
      if (previous === current) {
        return textOk(`theme unchanged (${current})`);
      }
      return textOk(`theme: ${previous} → ${current}`);
    },
  };
}
