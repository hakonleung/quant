/**
 * Pure helpers for the `/agent` flow — tool-call cap clamping, usage
 * arithmetic, formatting. Extracted out of `agent.service.ts` to keep
 * that file under the 400-LoC cap (CLAUDE.md §1.2). All functions are
 * stateless and have no IO; they're imported by `agent.service.ts` and
 * any future agent-specific helpers.
 */

import type { ChatTokenUsage } from '@quant/shared';

import { LLM_PROVIDERS, priceCallCny } from '../llm/providers.js';

export const DEFAULT_MAX_TOOL_CALLS = 5;
export const HARD_MAX_TOOL_CALLS = 10;
export const MIN_MAX_TOOL_CALLS = 1;

export function zeroUsage(): ChatTokenUsage {
  return { input: 0, output: 0, total: 0 };
}

export function sumUsage(a: ChatTokenUsage, b: ChatTokenUsage): ChatTokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    total: a.total + b.total,
  };
}

export function clampInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < MIN_MAX_TOOL_CALLS) return MIN_MAX_TOOL_CALLS;
  if (value > HARD_MAX_TOOL_CALLS) return HARD_MAX_TOOL_CALLS;
  return Math.trunc(value);
}

export function parseInteger(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.length > 0) {
    const v = Number(raw);
    return Number.isFinite(v) ? v : NaN;
  }
  return NaN;
}

export function formatArgs(args: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && /\s/.test(v)) {
      parts.push(`${k}="${v}"`);
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.join(' ');
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/**
 * Cost estimate using whichever provider currently has an API key in
 * env — close enough for the display footer; the per-call recorder
 * ledger has the exact figures.
 *
 * NOTE: this is the only `process.env` read left in the agent layer; it
 * is acceptable because the catalog scan mirrors `LlmService.resolve`'s
 * own provider-resolution heuristic and we don't want to plumb a copy
 * of the active provider through the agent loop just for a footer.
 * Returns 0 when no provider is configured (dev box without keys).
 */
export function estimateCnyCost(usage: ChatTokenUsage): number {
  for (const row of LLM_PROVIDERS) {
    const key = process.env[row.apiKeyEnv];
    if (typeof key === 'string' && key.length > 0) {
      return priceCallCny(row, usage);
    }
  }
  return 0;
}
