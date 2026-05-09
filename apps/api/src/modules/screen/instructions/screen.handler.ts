/**
 * `/screen` — kick off a natural-language screen from IM.
 *
 *   /screen "找昨日涨停今天回踩 ma5"
 *   /screen q="..." asof=2026-05-08
 *
 * Routes to `ScreenService.runNl` (Python `nl_screen` Flight op). LLM
 * translation + screen execution typically takes 5–15s, so the spec is
 * `mode: 'async'`: the IM listener acks immediately with a "queued"
 * card and pushes the matches once the worker finishes.
 *
 * v1 only exposes the NL entry point — `nl2dsl` and `run` would need
 * an AST input (impractical to type in IM); they remain HTTP-only.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  okResult,
  QuantError,
  type InstructionResult,
  type NlScreenResult,
  type ScreenMatchView,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { ScreenService } from '../screen.service.js';

const argsSchema = z
  .object({
    q: z.string().min(1).max(500),
    asof: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u, 'asof must be YYYY-MM-DD')
      .optional(),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

const MAX_MATCHES_DISPLAY = 10;

@Injectable()
export class ScreenInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('screen'),
    summary:
      'Run a natural-language screen via the LLM. `q="..."` (positional), `asof=YYYY-MM-DD`.',
    summaryCn: '自然语言选股，q="..." 描述筛选条件',
    group: 'market',
    argsSchema,
    positional: ['q'],
    imAliases: ['筛选', '选股'],
    mode: 'async',
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(ScreenService) private readonly screen: ScreenService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    try {
      const result = await this.screen.runNl(args.q, args.asof, ctx.traceId);
      return okResult(formatResult(result));
    } catch (err) {
      if (err instanceof QuantError) return errResult('handler', err.message);
      throw err;
    }
  }
}

function formatResult(r: NlScreenResult): string {
  const head = `screen "${r.nl}" asof=${r.asof}  matches=${String(r.matches.length)}`;
  if (r.matches.length === 0) return `${head}\n  (no matches)`;
  const top = r.matches.slice(0, MAX_MATCHES_DISPLAY).map((m, i) => formatMatch(m, i + 1));
  const tail =
    r.matches.length > MAX_MATCHES_DISPLAY
      ? `\n  …(+${String(r.matches.length - MAX_MATCHES_DISPLAY)} more)`
      : '';
  return `${head}\n${top.join('\n')}${tail}`;
}

function formatMatch(m: ScreenMatchView, ordinal: number): string {
  const evidenceParts: string[] = [];
  for (const [key, value] of Object.entries(m.evidence)) {
    if (typeof value === 'number' || typeof value === 'string') {
      evidenceParts.push(`${key}=${String(value)}`);
    }
    if (evidenceParts.length >= 3) break;
  }
  const evidence = evidenceParts.length > 0 ? `  ${evidenceParts.join(' ')}` : '';
  return `  ${String(ordinal).padStart(2)}. ${m.code}${evidence}`;
}
