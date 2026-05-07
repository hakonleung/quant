import { selectableList } from '../widgets/selectable-list.js';
import type { CommandSpec } from '../registry.js';
import { interactive, textErr, textOk } from '../widgets/helpers.js';

export const focusCommand: CommandSpec = {
  name: 'focus',
  summary: 'Set or clear the focused stock code (drives EQ.CHART pane).',
  subcommands: ['clear'],
  complete(positionalIdx, fragment, ctx) {
    if (positionalIdx === 0) {
      return ctx.stockIndex.complete(fragment).map((m) => ({ insert: m.code, label: m.label }));
    }
    return [];
  },
  async run(argv, ctx) {
    const arg = argv.positional[0];
    if (arg === 'clear') {
      ctx.stores.ui.setFocusCode(null);
      return textOk('focus cleared');
    }
    if (arg === undefined) {
      const items = ctx.stockIndex.all().map((m) => ({
        code: m.code,
        name: m.name,
        industry: m.industry ?? '',
      }));
      const widget = selectableList({
        title: 'focus: pick stock',
        items,
        columns: [
          { key: 'code', header: 'CODE', max: 8 },
          { key: 'name', header: 'NAME', max: 14 },
          { key: 'industry', header: 'IND', max: 10 },
        ],
        onCommit: (s) => ({ kind: 'command', line: `focus ${String(s.code)}` }),
      });
      return interactive(widget);
    }
    if (!/^\d{6}$/u.test(arg)) {
      return textErr(`invalid code: ${arg}`);
    }
    const meta = ctx.stockIndex.byCode(arg);
    if (meta === null) {
      return textErr(`stock ${arg} not found`);
    }
    ctx.stores.ui.setFocusCode(arg);
    return textOk(`focus = ${arg} ${meta.name}`);
  },
};
