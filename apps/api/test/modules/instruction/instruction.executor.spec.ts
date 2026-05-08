import { instructionId, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import { InstructionExecutor } from '../../../src/modules/instruction/instruction.executor.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionSpec } from '../../../src/modules/instruction/instruction.types.js';

const ctx: InstructionCtx = { traceId: 't1', source: 'socket' };

const focusSpec: InstructionSpec<{ code: string }> = {
  id: instructionId('focus'),
  summary: 'focus',
  argsSchema: z.object({ code: z.string().regex(/^\d{6}$/u) }).strict(),
  positional: ['code'],
};

function build(): { reg: InstructionRegistry; exe: InstructionExecutor } {
  const reg = new InstructionRegistry();
  const exe = new InstructionExecutor(reg);
  return { reg, exe };
}

describe('InstructionExecutor.execute', () => {
  it('runs handler when args validate', async () => {
    const { reg, exe } = build();
    reg.register(focusSpec, {
      execute(args): Promise<InstructionResult> {
        return Promise.resolve({ ok: true, output: { text: `focus=${args.code}` } });
      },
    });
    const r = await exe.execute('focus', { code: '600519' }, ctx);
    expect(r).toEqual({ ok: true, output: { text: 'focus=600519' } });
  });
  it('returns not-found for unknown id', async () => {
    const { exe } = build();
    const r = await exe.execute('nope', {}, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
  });
  it('returns validation when args fail zod', async () => {
    const { reg, exe } = build();
    reg.register(focusSpec, {
      execute(): Promise<InstructionResult> {
        throw new Error('should not be called');
      },
    });
    const r = await exe.execute('focus', { code: 'abc' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('validation');
  });
  it('wraps thrown handler error as code=handler', async () => {
    const { reg, exe } = build();
    reg.register(focusSpec, {
      execute(): Promise<InstructionResult> {
        throw new Error('boom');
      },
    });
    const r = await exe.execute('focus', { code: '600519' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('handler');
      expect(r.error.message).toBe('boom');
    }
  });
});

describe('InstructionExecutor.executeLine', () => {
  it('parses positional and runs', async () => {
    const { reg, exe } = build();
    reg.register(focusSpec, {
      execute(args): Promise<InstructionResult> {
        return Promise.resolve({ ok: true, output: { text: args.code } });
      },
    });
    const r = await exe.executeLine('focus 600519', ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.text).toBe('600519');
  });
  it('returns parse error on bad argv (unterminated quote)', async () => {
    const { reg, exe } = build();
    reg.register(focusSpec, {
      execute(): Promise<InstructionResult> {
        return Promise.resolve({ ok: true, output: { text: '' } });
      },
    });
    const r = await exe.executeLine('focus "abc', ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('parse');
  });
  it('returns parse=empty for blank', async () => {
    const { exe } = build();
    const r = await exe.executeLine('   ', ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('parse');
  });
});
