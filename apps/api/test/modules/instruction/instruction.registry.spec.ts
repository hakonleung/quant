import { instructionId, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionSpec } from '../../../src/modules/instruction/instruction.types.js';
import type { InstructionHandler } from '../../../src/modules/instruction/instruction.port.js';

type Args = z.infer<typeof argsSchema>;
const argsSchema = z.object({ x: z.string().optional() }).strict();

const noop: InstructionHandler<Args> = {
  execute(): Promise<InstructionResult> {
    return Promise.resolve({ ok: true, output: { text: 'ok' } });
  },
};

function spec(id: string, aliases: readonly string[] = []): InstructionSpec<Args> {
  return {
    id: instructionId(id),
    summary: 's',
    argsSchema,
    aliases: aliases.map((a) => instructionId(a)),
  };
}

describe('InstructionRegistry', () => {
  it('registers and resolves by id', () => {
    const r = new InstructionRegistry();
    r.register(spec('focus'), noop);
    expect(r.get('focus')?.spec.id).toBe('focus');
    expect(r.knownIds().has('focus')).toBe(true);
  });
  it('resolves aliases to canonical id', () => {
    const r = new InstructionRegistry();
    r.register(spec('watch', ['watch.list']), noop);
    expect(r.get('watch.list')?.spec.id).toBe('watch');
    expect(r.resolveId('watch.list')).toBe('watch');
  });
  it('rejects duplicate id', () => {
    const r = new InstructionRegistry();
    r.register(spec('focus'), noop);
    expect(() => {
      r.register(spec('focus'), noop);
    }).toThrow(/duplicate/);
  });
  it('rejects alias that collides with existing id', () => {
    const r = new InstructionRegistry();
    r.register(spec('focus'), noop);
    expect(() => {
      r.register(spec('other', ['focus']), noop);
    }).toThrow(/duplicate/);
  });
  it('rejects alias that collides with another alias', () => {
    const r = new InstructionRegistry();
    r.register(spec('a', ['shared']), noop);
    expect(() => {
      r.register(spec('b', ['shared']), noop);
    }).toThrow(/duplicate/);
  });
});
