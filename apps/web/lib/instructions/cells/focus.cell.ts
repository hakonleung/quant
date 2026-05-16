/**
 * FE `/focus` cell — set / clear the focused stock code (drives
 * EQ.CHART pane).
 *
 * Pure-FE: reads `ctx.stockIndex` for completion + validation,
 * mutates `ctx.stores.ui.setFocusCode(...)`. No BE call.
 *
 * Three branches:
 *   - `focus`           → renderer opens the interactive picker
 *   - `focus clear`     → clear the focus
 *   - `focus <6-digit>` → set focus (must exist in the stock index)
 */

import {
  InstructionDispatchError,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';
import { interactive, selectableList, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type FocusResult = ResultOf<'focus'>;

export function buildFocusCell(): InstructionCell<FeEnv, 'focus'> {
  return {
    async handler(args, ctx): Promise<FocusResult> {
      const arg = args.id;
      if (arg === undefined) return { kind: 'pick' };
      if (arg === 'clear') {
        ctx.stores.ui.setFocusCode(null);
        return { kind: 'cleared' };
      }
      if (!/^\d{6}$/u.test(arg)) {
        throw new InstructionDispatchError('validation', `invalid code: ${arg}`);
      }
      const meta = ctx.stockIndex.byCode(arg);
      if (meta === null) {
        throw new InstructionDispatchError('not-found', `stock ${arg} not found`);
      }
      ctx.stores.ui.setFocusCode(arg);
      return { kind: 'set', code: arg, name: meta.name };
    },
    renderer(envelope, host) {
      if (!envelope.ok) {
        return {
          kind: 'text',
          status: 'err',
          tail: { body: `${envelope.error.code}: ${envelope.error.message}` },
        };
      }
      const r = envelope.data;
      if (r.kind === 'cleared') return textOk('focus cleared');
      if (r.kind === 'set') return textOk(`focus = ${r.code} ${r.name}`);
      // 'pick' — open the stock picker. The renderer reads the index
      // from `host` (host.stockIndex), keeping the renderer pure.
      const items = host.stockIndex.all().map((m) => ({
        code: m.code,
        name: m.name,
        industry: m.industry ?? '',
      }));
      return interactive(
        selectableList({
          title: 'focus: pick stock',
          items,
          columns: [
            { key: 'code', header: 'CODE', max: 8 },
            { key: 'name', header: 'NAME', max: 14 },
            { key: 'industry', header: 'IND', max: 10 },
          ],
          onCommit: (s) => ({ kind: 'command', line: `focus ${String(s.code)}` }),
        }),
      );
    },
  };
}
