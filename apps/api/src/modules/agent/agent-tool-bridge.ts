/**
 * Bridge between the instruction registry and the agent's LLM tool
 * surface. Two responsibilities:
 *
 *   1. `exposeForAgent()` — walk the registry, render each (non-`agent`)
 *      InstructionSpec into a `ChatTool`. The model sees stable id +
 *      one-line summary + a JSON-Schema describing args; that's enough
 *      to emit a valid `tool_calls` round.
 *   2. `executeToolCall(call, ctx)` — run a model-emitted tool call by
 *      handing it to `InstructionExecutor.execute`. Returns the
 *      `InstructionResult` so the loop can both:
 *        a) feed the formatted text back as a `role:'tool'` message,
 *        b) emit a `tool_result` socket frame for the UI.
 *
 * The /agent instruction itself is excluded from the exposed list — we
 * don't want the model recursively calling itself.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  formatResult,
  type ChatTool,
  type ChatToolCall,
  type InstructionResult,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../instruction/instruction.port.js';
import { InstructionExecutor } from '../instruction/instruction.executor.js';
import { InstructionRegistry } from '../instruction/instruction.registry.js';

const SELF_INSTRUCTION_ID = 'agent';
const AGENT_CONFIRM_INSTRUCTION_ID = 'agent.confirm';

@Injectable()
export class AgentToolBridge {
  private readonly logger = new Logger(AgentToolBridge.name);

  constructor(
    @Inject(InstructionRegistry) private readonly registry: InstructionRegistry,
    @Inject(InstructionExecutor) private readonly executor: InstructionExecutor,
  ) {}

  /** All non-self instructions, surfaced as `ChatTool`s for the LLM. */
  exposeForAgent(): readonly ChatTool[] {
    const tools: ChatTool[] = [];
    for (const entry of this.registry.list()) {
      const id = String(entry.spec.id);
      if (id === SELF_INSTRUCTION_ID || id === AGENT_CONFIRM_INSTRUCTION_ID) continue;
      const description = describeSpec(entry.spec.summary, entry.spec.summaryCn);
      let schema: Record<string, unknown>;
      try {
        schema = zodToJsonSchema(entry.spec.argsSchema);
      } catch (err) {
        this.logger.warn(
          `agent_tool_schema_failed id=${id} err=${String(err)}; falling back to free-form object`,
        );
        schema = { type: 'object', additionalProperties: true };
      }
      tools.push({ id, description, schema });
    }
    return tools;
  }

  /**
   * Execute one tool call from the LLM **synchronously**. We deliberately
   * use `executeHandler` rather than `execute`: when the agent calls an
   * `mode:'async'` instruction (`/ta`, `/screen`, `/analyze`), routing
   * through `execute()` would enqueue a BullMQ job and return a "queued"
   * ack — which the LLM then treats as the tool result and the loop stalls
   * with "I've started the analysis" but no actual data. `executeHandler`
   * runs the handler inline so the agent gets the real result back as a
   * `role:'tool'` message and can continue reasoning.
   */
  async executeToolCall(call: ChatToolCall, ctx: InstructionCtx): Promise<InstructionResult> {
    return this.executor.executeHandler(call.toolId, call.args, ctx);
  }

  /** Render a tool result as the `role:'tool'` message body. */
  toolMessageContent(result: InstructionResult): string {
    return formatResult(result);
  }

  /**
   * Look up a spec to decide whether the call needs user confirmation
   * before execution.
   */
  needsConfirmation(toolId: string): boolean {
    const entry = this.registry.get(toolId);
    if (entry === undefined) return false;
    return entry.spec.costsCredits === true || entry.spec.destructive === true;
  }

  /** Spec summary — used by the confirmation card / widget. */
  summary(toolId: string): string {
    const entry = this.registry.get(toolId);
    if (entry === undefined) return toolId;
    return entry.spec.summary;
  }
}

function describeSpec(summary: string, summaryCn: string): string {
  // Provide both in the model description so a Chinese-trained model has
  // the more informative side. Token cost is negligible (~30 tokens).
  return `${summary} | ${summaryCn}`;
}

// ---------------------------------------------------------------------------
// minimal zod → JSON-Schema converter
// ---------------------------------------------------------------------------

/**
 * The agent only ever exposes top-level zod object schemas with simple
 * primitive / optional / enum / string fields. We avoid pulling in the
 * full `zod-to-json-schema` package (~30 KB + transitive deps) and write
 * the narrow conversion we actually need. Anything fancier falls through
 * to `{ type: 'object', additionalProperties: true }` so the model still
 * sees something usable.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName?: string };
  const typeName = def.typeName;
  if (typeName === 'ZodObject') {
    const obj = schema as z.ZodObject<z.ZodRawShape>;
    const shape = obj.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, raw] of Object.entries(shape)) {
      const inner = raw as z.ZodTypeAny;
      const innerType = (inner._def as { typeName?: string }).typeName;
      const optional = innerType === 'ZodOptional' || innerType === 'ZodDefault';
      const next = optional ? unwrap(inner) : inner;
      properties[key] = simpleSchema(next);
      if (!optional) required.push(key);
    }
    const out: Record<string, unknown> = {
      type: 'object',
      properties,
      additionalProperties: false,
    };
    if (required.length > 0) out['required'] = required;
    return out;
  }
  return { type: 'object', additionalProperties: true };
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = schema._def as { typeName?: string; innerType?: z.ZodTypeAny };
  if (def.typeName === 'ZodOptional' && def.innerType) return def.innerType;
  if (def.typeName === 'ZodDefault' && def.innerType) return def.innerType;
  return schema;
}

/**
 * JSON-Schema fragment per Zod-typeName. Keeps the dispatch table flat —
 * `simpleSchema` then composes the result with `description`. Cases that
 * need the full def (literal value, array inner type) are extracted into
 * named helpers so the dispatch stays under the cyclomatic-complexity
 * cap (CLAUDE.md §1.2).
 */
const SIMPLE_SCHEMA_BUILDERS: Readonly<
  Record<string, (def: ZodAnyDef) => Record<string, unknown>>
> = {
  ZodString: () => ({ type: 'string' }),
  ZodNumber: () => ({ type: 'number' }),
  ZodBoolean: () => ({ type: 'boolean' }),
  ZodEnum: (def) => ({ type: 'string', enum: def.values ?? [] }),
  ZodLiteral: literalSchema,
  ZodArray: arraySchema,
  // Coerce unions to a free string — simpler for the model than anyOf in
  // v1, and our union args are usually `string | boolean`.
  ZodUnion: () => ({ type: 'string' }),
};

interface ZodAnyDef {
  readonly typeName?: string;
  readonly values?: readonly string[];
  readonly description?: string;
}

function literalSchema(def: ZodAnyDef): Record<string, unknown> {
  const v = (def as { value?: unknown }).value;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return { type: t, const: v };
  }
  return { type: 'string', const: String(v) };
}

function arraySchema(def: ZodAnyDef): Record<string, unknown> {
  const inner = (def as { type?: z.ZodTypeAny }).type;
  if (inner === undefined) return { type: 'array' };
  return { type: 'array', items: simpleSchema(inner) };
}

function simpleSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as ZodAnyDef;
  const description = def.description;
  const builder =
    def.typeName !== undefined ? SIMPLE_SCHEMA_BUILDERS[def.typeName] : undefined;
  const base: Record<string, unknown> = builder !== undefined ? builder(def) : { type: 'string' };
  if (description !== undefined) base['description'] = description;
  return base;
}
