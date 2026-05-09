import { instructionId } from '@quant/shared';
import { z } from 'zod';

import { AgentToolBridge, zodToJsonSchema } from '../../../src/modules/agent/agent-tool-bridge.js';
import type { InstructionExecutor } from '../../../src/modules/instruction/instruction.executor.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type {
  InstructionHandler,
  InstructionCtx,
} from '../../../src/modules/instruction/instruction.port.js';
import type { InstructionSpec } from '../../../src/modules/instruction/instruction.types.js';

function makeRegistry(): InstructionRegistry {
  const r = new InstructionRegistry();
  const focusSpec: InstructionSpec<{ code: string }> = {
    id: instructionId('focus'),
    summary: 'Lookup a stock by code',
    summaryCn: '按代码查询一只股票',
    group: 'market',
    argsSchema: z.object({ code: z.string() }).strict(),
  };
  const focusHandler: InstructionHandler<{ code: string }> = {
    execute: async () => ({ ok: true, output: { text: 'focused' } }),
  };
  r.register(focusSpec, focusHandler);

  const screenSpec: InstructionSpec<{ q: string }> = {
    id: instructionId('screen'),
    summary: 'NL screening',
    summaryCn: '自然语言选股',
    group: 'market',
    argsSchema: z.object({ q: z.string() }).strict(),
    costsCredits: true,
  };
  const screenHandler: InstructionHandler<{ q: string }> = {
    execute: async () => ({ ok: true, output: { text: 'screened' } }),
  };
  r.register(screenSpec, screenHandler);

  const updateSpec: InstructionSpec<{ target: string }> = {
    id: instructionId('update'),
    summary: 'Refresh blacklist',
    summaryCn: '刷新黑名单',
    group: 'system',
    argsSchema: z.object({ target: z.string() }).strict(),
    destructive: true,
  };
  const updateHandler: InstructionHandler<{ target: string }> = {
    execute: async () => ({ ok: true, output: { text: 'updated' } }),
  };
  r.register(updateSpec, updateHandler);

  // /agent should be excluded from the exposed tool list.
  const agentSpec: InstructionSpec<unknown> = {
    id: instructionId('agent'),
    summary: 'agent',
    summaryCn: 'agent',
    group: 'system',
    argsSchema: z.object({}).passthrough(),
  };
  r.register(agentSpec, {
    execute: async () => ({ ok: true, output: { text: 'never called' } }),
  });
  return r;
}

const ctx: InstructionCtx = { traceId: 't1', source: 'socket', userId: 'admin' };

describe('AgentToolBridge.exposeForAgent', () => {
  it('returns one tool per non-self instruction with id + description + schema', () => {
    const r = makeRegistry();
    const exec = { execute: async () => ({ ok: true, output: { text: '' } }) } as unknown as InstructionExecutor;
    const bridge = new AgentToolBridge(r, exec);
    const tools = bridge.exposeForAgent();
    const ids = tools.map((t) => t.id).sort();
    expect(ids).toEqual(['focus', 'screen', 'update']);
    const focusTool = tools.find((t) => t.id === 'focus');
    expect(focusTool?.description).toContain('stock');
    expect(focusTool?.description).toContain('股票');
    expect(focusTool?.schema).toMatchObject({
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    });
  });

  it('does not duplicate tools for aliases', () => {
    const r = makeRegistry();
    const exec = { execute: async () => ({ ok: true, output: { text: '' } }) } as unknown as InstructionExecutor;
    const bridge = new AgentToolBridge(r, exec);
    const tools = bridge.exposeForAgent();
    expect(new Set(tools.map((t) => t.id)).size).toBe(tools.length);
  });
});

describe('AgentToolBridge.needsConfirmation', () => {
  it('flags costsCredits (screen) and destructive (update) as needing confirm', () => {
    const r = makeRegistry();
    const exec = {} as InstructionExecutor;
    const bridge = new AgentToolBridge(r, exec);
    expect(bridge.needsConfirmation('screen')).toBe(true);
    expect(bridge.needsConfirmation('update')).toBe(true);
    expect(bridge.needsConfirmation('focus')).toBe(false);
  });

  it('returns false for unknown ids (defaults to not requiring confirm)', () => {
    const r = makeRegistry();
    const exec = {} as InstructionExecutor;
    const bridge = new AgentToolBridge(r, exec);
    expect(bridge.needsConfirmation('does-not-exist')).toBe(false);
  });
});

describe('AgentToolBridge.executeToolCall', () => {
  it('routes the call through InstructionExecutor.execute', async () => {
    const r = makeRegistry();
    const calls: { id: string; args: unknown }[] = [];
    const exec = {
      execute: async (id: string, args: unknown) => {
        calls.push({ id, args });
        return { ok: true, output: { text: `executed ${id}` } };
      },
    } as unknown as InstructionExecutor;
    const bridge = new AgentToolBridge(r, exec);
    const result = await bridge.executeToolCall(
      { id: 'tc-1', toolId: 'focus', args: { code: '600519' } },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ id: 'focus', args: { code: '600519' } }]);
  });
});

describe('zodToJsonSchema', () => {
  it('renders primitives + optional + enum', () => {
    const schema = z
      .object({
        code: z.string(),
        limit: z.number().optional(),
        side: z.enum(['buy', 'sell']),
      })
      .strict();
    const json = zodToJsonSchema(schema);
    expect(json).toMatchObject({
      type: 'object',
      properties: {
        code: { type: 'string' },
        limit: { type: 'number' },
        side: { type: 'string', enum: ['buy', 'sell'] },
      },
      required: ['code', 'side'],
    });
  });

  it('falls back to free-form object for non-ZodObject input', () => {
    const json = zodToJsonSchema(z.string());
    expect(json).toMatchObject({ type: 'object', additionalProperties: true });
  });
});
