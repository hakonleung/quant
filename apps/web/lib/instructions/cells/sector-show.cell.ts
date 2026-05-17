/**
 * FE `/sector.show <id>` cell — sector detail + member rows.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { ANSI, paint, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type SectorShowResult = ResultOf<'sector.show'>;

export function buildSectorShowCell(): InstructionCell<FeEnv, 'sector.show'> {
  return {
    async handler(args, ctx): Promise<SectorShowResult> {
      const env = await ctx.api.invoke('sector.show', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const s = envelope.data;
      const lines: string[] = [
        paint(`${s.id}  ${s.name}  (${s.kind})`, ANSI.bold, ANSI.cyan),
        `published: ${s.published ? 'yes' : 'no'}   own: ${s.isOwn ? 'yes' : 'no'}   members: ${String(s.totalCount)}`,
      ];
      for (const code of s.codes.slice(0, 30)) {
        const row = s.stockRows?.find((r) => r.code === code);
        const name = row?.name ?? code;
        lines.push(`  ${code}  ${name}`);
      }
      if (s.codes.length > 30) {
        lines.push(`  … +${String(s.codes.length - 30)} more`);
      }
      return textOk(lines.join('\n'));
    },
  };
}
