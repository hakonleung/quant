import { Inject, Injectable } from '@nestjs/common';
import { instructionId, okResult, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../instruction.port.js';
import { InstructionRegistrarBase } from '../instruction.provider.js';
import { InstructionRegistry } from '../instruction.registry.js';
import type { InstructionSpec } from '../instruction.types.js';

const argsSchema = z
  .object({
    id: z.string().optional(),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

@Injectable()
export class HelpHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('help'),
    summary: 'List registered instructions, or show detail for one id.',
    argsSchema,
    positional: ['id'],
  };

  constructor(@Inject(InstructionRegistry) registry: InstructionRegistry) {
    super(registry);
  }

  execute(args: Args, _ctx: InstructionCtx): Promise<InstructionResult> {
    if (args.id !== undefined && args.id.length > 0) {
      const entry = this.registry.get(args.id);
      if (entry === undefined) {
        return Promise.resolve(okResult(`unknown instruction: ${args.id}`));
      }
      const lines: string[] = [
        `${entry.spec.id} — ${entry.spec.summary}`,
        ...(entry.spec.help !== undefined ? [entry.spec.help] : []),
        ...(entry.spec.positional !== undefined && entry.spec.positional.length > 0
          ? [`positional: ${entry.spec.positional.join(' ')}`]
          : []),
        ...(entry.spec.aliases !== undefined && entry.spec.aliases.length > 0
          ? [`aliases: ${entry.spec.aliases.join(', ')}`]
          : []),
      ];
      return Promise.resolve(okResult(lines.join('\n')));
    }
    const list = this.registry.list();
    const sorted = [...list].sort((a, b) => a.spec.id.localeCompare(b.spec.id));
    const body = sorted.map((e) => `  ${e.spec.id.padEnd(18)} ${e.spec.summary}`).join('\n');
    return Promise.resolve(
      okResult(`registered instructions (${String(sorted.length)}):\n${body}`),
    );
  }
}
