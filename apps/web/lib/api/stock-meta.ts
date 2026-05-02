/**
 * Server-side fetch helpers for the stock-meta HTTP API.
 *
 * These run in **Server Components only** (or in Next.js Route Handlers).
 * They never reach the browser bundle, so the API base URL stays
 * server-only. CLAUDE.md §2.5 — service calls live in `lib/`, not in
 * components.
 *
 * The response is validated against `StockMetaDtoSchema` so the UI never
 * receives a shape that drifted from the gateway/server contract.
 */

import {
  QuantError,
  StockMetaDtoSchema,
  TRACE_HEADER,
  isErrorCode,
  newTraceId,
  type ErrorCode,
  type StockMetaDto,
} from '@quant/shared';
import { z } from 'zod';

const DEFAULT_BASE = 'http://127.0.0.1:3001';

const StockMetaListSchema = z.array(StockMetaDtoSchema);

interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly trace_id: string;
  readonly details: Readonly<Record<string, unknown>>;
}

const ErrorBodySchema = z
  .object({
    code: z.string(),
    message: z.string(),
    trace_id: z.string(),
    details: z.record(z.unknown()),
  })
  .strict();

export interface StockMetaFetchOptions {
  readonly traceId?: string;
  /** Override the API base URL (otherwise reads `QUANT_API_BASE`). */
  readonly baseUrl?: string;
  /** Forwarded to `fetch`'s Next.js `cache` hint. */
  readonly cache?: RequestCache;
  /** Forwarded to `fetch`'s Next.js `next.revalidate` hint. */
  readonly revalidateSeconds?: number;
}

export async function fetchStockMeta(
  code: string,
  options: StockMetaFetchOptions = {},
): Promise<StockMetaDto> {
  const body: unknown = await callApi(`/api/stocks/${encodeURIComponent(code)}`, options);
  return StockMetaDtoSchema.parse(body);
}

export async function fetchStockMetaBatch(
  codes: readonly string[],
  options: StockMetaFetchOptions = {},
): Promise<readonly StockMetaDto[]> {
  if (codes.length === 0) return [];
  const query = `?codes=${codes.map(encodeURIComponent).join(',')}`;
  const body: unknown = await callApi(`/api/stocks/batch${query}`, options);
  return StockMetaListSchema.parse(body);
}

export async function fetchAllStockMeta(
  options: StockMetaFetchOptions = {},
): Promise<readonly StockMetaDto[]> {
  const body: unknown = await callApi('/api/stocks', options);
  return StockMetaListSchema.parse(body);
}

export async function fetchStockMetaByIndustry(
  swL2: string,
  options: StockMetaFetchOptions = {},
): Promise<readonly StockMetaDto[]> {
  const query = `?sw_l2=${encodeURIComponent(swL2)}`;
  const body: unknown = await callApi(`/api/stocks/by-industry${query}`, options);
  return StockMetaListSchema.parse(body);
}

async function callApi(pathAndQuery: string, options: StockMetaFetchOptions): Promise<unknown> {
  const base = options.baseUrl ?? process.env['QUANT_API_BASE'] ?? DEFAULT_BASE;
  const traceId = options.traceId ?? newTraceId();
  const url = `${base}${pathAndQuery}`;

  const init: RequestInit & { next?: { revalidate: number } } = {
    headers: { [TRACE_HEADER]: traceId },
  };
  if (options.cache !== undefined) init.cache = options.cache;
  if (options.revalidateSeconds !== undefined) {
    init.next = { revalidate: options.revalidateSeconds };
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const errBody = (await safeJson(res)) ?? null;
    const parsed = ErrorBodySchema.safeParse(errBody);
    if (parsed.success) {
      throw fromErrorBody(parsed.data);
    }
    throw new QuantError('INTERNAL', `${url} → ${String(res.status)}`, {
      status: res.status,
      trace_id: traceId,
    });
  }
  return res.json();
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function fromErrorBody(body: ErrorBody): QuantError {
  const code: ErrorCode = isErrorCode(body.code) ? body.code : 'INTERNAL';
  return new QuantError(code, body.message, { ...body.details, trace_id: body.trace_id });
}
