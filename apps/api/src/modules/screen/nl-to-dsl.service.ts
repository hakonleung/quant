/**
 * Translate Chinese natural-language queries → screening DSL.
 *
 * Single LLM round-trip with `response_format: json_object` enforced
 * by `LlmService.completeJson` — there is no validation retry. If the
 * model output fails AST validation we throw `NL_TRANSLATION_FAILED`
 * with the offending snippet so the caller can decide whether to
 * surface the error or let the user re-try.
 *
 * All AST nodes are validated through `op-to-kind.ts` so the LLM can
 * never sneak unsupported ops or fields past us.
 *
 * Output is the wire form (`kind`-tagged) ready to feed into the
 * in-process `ScreenExecService.execute`.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  QuantError,
  type RankSpecView,
  type ScreenPlanAst,
  type UniversePlanAst,
} from '@quant/shared';

import { LlmService } from '../llm/llm.service.js';
import {
  convertRankFromOpTagged,
  convertScreenPlanFromOpTagged,
  convertUniversePlanFromOpTagged,
} from './op-to-kind.js';
import { buildNlToDslSystemPrompt } from './prompts/nl-to-dsl.prompt.js';

export interface NlToDslTranslation {
  readonly screenPlan: ScreenPlanAst;
  readonly universePlan: UniversePlanAst | null;
  readonly rank: RankSpecView | null;
  readonly warnings: readonly string[];
}

export interface NlToDslArgs {
  readonly nl: string;
  readonly asof: string;
  readonly userId: string;
  readonly traceId: string;
}

@Injectable()
export class NlToDslService {
  private readonly logger = new Logger(NlToDslService.name);

  constructor(@Inject(LlmService) private readonly llm: LlmService) {}

  async translate(args: NlToDslArgs): Promise<NlToDslTranslation> {
    if (args.nl.trim().length === 0) {
      throw new QuantError('NL_TRANSLATION_FAILED', 'empty natural-language query', {
        nl: args.nl,
      });
    }
    // System prompt is date-free so byte-prefix stays identical across
    // days — DeepSeek / Qwen prefix caches stay warm. asof lives in the
    // user message instead; the system prompt tells the model to copy
    // that date into `asof` literally.
    const system = buildNlToDslSystemPrompt();
    const user = `今天日期: ${args.asof}\nUser query (Chinese):\n${args.nl.trim()}`;
    const out = await this.llm.completeJson(
      { system, user },
      { userId: args.userId, traceId: args.traceId, scope: 'screen' },
    );
    try {
      return parseLlmResponse(out.text);
    } catch (err) {
      if (err instanceof QuantError && err.code === 'DSL_INVALID') {
        this.logger.warn(
          `nl_to_dsl_validation_failed trace_id=${args.traceId} error=${err.message} raw_snippet=${out.text.slice(0, 500)}`,
        );
        throw new QuantError(
          'NL_TRANSLATION_FAILED',
          `could not produce a valid plan: ${err.message}`,
          { nl: args.nl, last_raw: out.text.slice(0, 1000) },
        );
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// pure JSON → translation parser
// ---------------------------------------------------------------------------

function parseLlmResponse(raw: string): NlToDslTranslation {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.trim()) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QuantError('DSL_INVALID', `LLM output is not valid JSON: ${msg}`, {
      snippet: raw.slice(0, 200),
    });
  }
  if (!isRecord(payload)) {
    throw new QuantError('DSL_INVALID', 'LLM did not return a JSON object', {});
  }
  const planRaw = payload['screen_plan'];
  if (!isRecord(planRaw)) {
    throw new QuantError('DSL_INVALID', "missing 'screen_plan' object", {});
  }
  const screenPlan = convertScreenPlanFromOpTagged(planRaw);
  const universePlan = isRecord(payload['universe_plan'])
    ? convertUniversePlanFromOpTagged(payload['universe_plan'])
    : null;
  const rank = isRecord(payload['rank']) ? convertRankFromOpTagged(payload['rank']) : null;
  const warningsRaw = payload['warnings'];
  const warnings: readonly string[] = Array.isArray(warningsRaw)
    ? warningsRaw.filter((w): w is string => typeof w === 'string')
    : [];
  return { screenPlan, universePlan, rank, warnings };
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
