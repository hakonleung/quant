import type { Request, Response, NextFunction } from 'express';
import { TRACE_HEADER } from '@quant/shared';
import { TraceMiddleware, type RequestWithTraceId } from '../../src/common/trace.middleware.js';

interface FakeReq {
  headers: Record<string, string>;
  traceId?: string;
  header(name: string): string | undefined;
}

function makeReq(headers: Record<string, string> = {}): FakeReq {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: lower,
    header(name: string): string | undefined {
      return lower[name.toLowerCase()];
    },
  };
}

function makeRes(): { res: Pick<Response, 'setHeader'>; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    res: {
      setHeader(name: string, value: number | string | readonly string[]): Response {
        headers[name] = String(value);
        return undefined as unknown as Response;
      },
    },
  };
}

describe('TraceMiddleware', () => {
  const middleware = new TraceMiddleware();

  it('uses the inbound x-trace-id when present', () => {
    const req = makeReq({ [TRACE_HEADER]: 'inbound-tid' });
    const { res, headers } = makeRes();
    let called = false;
    middleware.use(
      req as unknown as Request,
      res as Response,
      (() => {
        called = true;
      }) as NextFunction,
    );
    expect(called).toBe(true);
    expect((req as unknown as RequestWithTraceId).traceId).toBe('inbound-tid');
    expect(headers[TRACE_HEADER]).toBe('inbound-tid');
  });

  it('synthesises an id when no header is present', () => {
    const req = makeReq();
    const { res, headers } = makeRes();
    middleware.use(req as unknown as Request, res as Response, (() => {}) as NextFunction);
    const tid = (req as unknown as RequestWithTraceId).traceId;
    expect(tid).toMatch(/^[0-9a-f]{32}$/);
    expect(headers[TRACE_HEADER]).toBe(tid);
  });

  it('treats an empty inbound header as missing', () => {
    const req = makeReq({ [TRACE_HEADER]: '' });
    const { res } = makeRes();
    middleware.use(req as unknown as Request, res as Response, (() => {}) as NextFunction);
    const tid = (req as unknown as RequestWithTraceId).traceId;
    expect(tid).toMatch(/^[0-9a-f]{32}$/);
  });
});
