import { renderTable } from '../render/table.js';
import type { CommandRegistry, CommandSpec } from '../registry.js';
import { textErr, textOk } from '../widgets/helpers.js';

export function helpCommand(registry: CommandRegistry): CommandSpec {
  return {
    name: 'help',
    summary: 'List all commands or describe one (`help <name>`).',
    async run(argv) {
      const name = argv.positional[0];
      if (name === undefined) {
        const rows = registry.list().map((c) => ({ NAME: c.name, SUMMARY: c.summary }));
        return textOk(
          renderTable(rows, [
            { key: 'NAME', header: 'CMD', max: 14 },
            { key: 'SUMMARY', header: 'SUMMARY', max: 80 },
          ]),
        );
      }
      const spec = registry.resolve(name);
      if (spec === undefined) return textErr(`unknown command: ${name}`);
      const subs = (spec.subcommands ?? []).join(' / ') || '(none)';
      const aliases = (spec.aliases ?? []).join(', ') || '(none)';
      return textOk(
        [`# ${spec.name}`, `aliases:    ${aliases}`, `subcommands: ${subs}`, ``, spec.summary].join(
          '\n',
        ),
      );
    },
  };
}
