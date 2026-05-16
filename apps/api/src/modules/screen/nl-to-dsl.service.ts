/**
 * Translate Chinese natural-language queries → screening DSL.
 *
 * Replaces the Python `quant_core.services.nl_to_dsl_service.NlToDslService`
 * (deleted as part of the LLM-on-NestJS migration). Behaviour parity:
 *
 *   - Single LLM round-trip with one validation retry.
 *   - System prompt is the verbatim Chinese template the Python version
 *     used (see `prompts/nl-to-dsl.prompt.ts`).
 *   - On retry, hand the validator's error + the offending JSON back to
 *     the model so it can self-correct.
 *   - All AST nodes are validated through `op-to-kind.ts` so the LLM can
 *     never sneak unsupported ops or fields past us.
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
    const system = buildNlToDslSystemPrompt(args.asof);
    let user = `User query (Chinese):\n${args.nl.trim()}`;
    let firstError: string | null = null;
    let lastRaw = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await this.llm.completeJson(
        { system, user },
        { userId: args.userId, traceId: args.traceId, scope: 'screen' },
      );
      lastRaw = out.text;
      try {
        return parseLlmResponse(out.text);
      } catch (err) {
        if (err instanceof QuantError && err.code === 'DSL_INVALID') {
          firstError = err.message;
          this.logger.warn(
            `nl_to_dsl_validation_failed attempt=${String(attempt)} trace_id=${args.traceId} error=${err.message} raw_snippet=${out.text.slice(0, 500)}`,
          );
          // Echo the error + offending JSON back to the model.
          user =
            `User query (Chinese):\n${args.nl.trim()}\n\n` +
            `Your previous JSON failed validation: ${err.message}\n` +
            `Previous JSON was:\n${out.text}\n\n` +
            'Emit the corrected JSON only. Do not repeat the same mistake.';
          continue;
        }
        throw err;
      }
    }
    throw new QuantError(
      'NL_TRANSLATION_FAILED',
      `could not produce a valid plan after 2 attempts: ${firstError ?? '(no error captured)'}`,
      { nl: args.nl, last_raw: lastRaw.slice(0, 1000) },
    );
  }
}

// ---------------------------------------------------------------------------
// pure JSON → translation parser
// ---------------------------------------------------------------------------

function parseLlmResponse(raw: string): NlToDslTranslation {
  const payload = extractJsonObject(raw);
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

const FENCE_RE = /^```(?:json)?\s*([\s\S]+?)```$/u;

function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  const fenced = FENCE_RE.exec(text);
  const stripped = fenced !== null ? (fenced[1]?.trim() ?? '') : text;
  try {
    return JSON.parse(stripped) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QuantError('DSL_INVALID', `LLM output is not valid JSON: ${msg}`, {
      snippet: raw.slice(0, 200),
    });
  }
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
