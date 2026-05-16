/**
 * Browser-side typed client for `POST /api/instructions/:id`.
 *
 * Wraps fetch + zod validation: on 2xx, parses the body against the
 * manifest's `resultSchema` for `id`; on 4xx/5xx, parses the body as
 * an `InstructionError`. Either way returns an
 * `InstructionEnvelope<ResultOf<I>>` so FE cells branch on `ok`.
 *
 * Network failures (Nest down, parse mismatch) collapse to
 * `error.code === 'handler'`.
 *
 * Used by every FE cell built via `feCenter`. Per-feature endpoints
 * are retired as cells migrate (legacy `/api/sectors`,
 * `/api/sentiment/analyze_one`, etc. eventually disappear).
 */

import {
  INSTRUCTION_MANIFEST,
  TRACE_HEADER,
  newTraceId,
  type AllInstructionIds,
  type ArgsOf,
  type CommandManifestEntry,
  type InstructionEnvelope,
  type InstructionError,
  type ResultOf,
} from '@quant/shared';
import { z } from 'zod';

export interface InvokeOptions {
  readonly signal?: AbortSignal;
  readonly traceId?: string;
}

const ErrorBodySchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .passthrough();

export async function invokeInstruction<I extends AllInstructionIds>(
  id: I,
  args: ArgsOf<I>,
  options: InvokeOptions = {},
): Promise<InstructionEnvelope<ResultOf<I>>> {
  const entry: CommandManifestEntry | undefined = (
    INSTRUCTION_MANIFEST as Record<string, CommandManifestEntry | undefined>
  )[id];
  if (entry === undefined) {
    return errEnvelope('not-found', `unknown instruction: ${String(id)}`);
  }
  const traceId = options.traceId ?? newTraceId();
  const headers: Record<string, string> = {
    [TRACE_HEADER]: traceId,
    'content-type': 'application/json',
  };
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(args ?? {}),
  };
  if (options.signal !== undefined) init.signal = options.signal;
  let res: Response;
  try {
    res = await fetch(`/api/instructions/${encodeURIComponent(id)}`, init);
  } catch (err) {
    return errEnvelope('handler', err instanceof Error ? err.message : String(err));
  }
  const rawText = await res.text();
  let raw: unknown;
  try {
    raw = rawText.length === 0 ? {} : JSON.parse(rawText);
  } catch {
    return errEnvelope('handler', `non-JSON body (status ${String(res.status)})`);
  }
  if (!res.ok) {
    const parsed = ErrorBodySchema.safeParse(raw);
    if (parsed.success) {
      return {
        ok: false,
        error: { code: parsed.data.code as InstructionError['code'], message: parsed.data.message },
      };
    }
    return errEnvelope('handler', `unrecognised error body (status ${String(res.status)})`);
  }
  const data = entry.resultSchema.safeParse(raw);
  if (!data.success) {
    return errEnvelope(
      'handler',
      `result schema mismatch for ${String(id)}: ${data.error.issues
        .map((i) => i.message)
        .join('; ')}`,
    );
  }
  return { ok: true, data: data.data as ResultOf<I> };
}

function errEnvelope<R>(code: InstructionError['code'], message: string): InstructionEnvelope<R> {
  return { ok: false, error: { code, message } };
}
