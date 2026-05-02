import type { ArgumentsHost } from '@nestjs/common';
import type { Request, Response } from 'express';
import { QuantError, TRACE_HEADER } from '@quant/shared';
import { QuantErrorFilter } from '../../src/common/quant-error.filter.js';

interface CapturedResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

function makeHost(traceId: string | undefined): {
  host: ArgumentsHost;
  captured: CapturedResponse;
} {
  const captured: { status: number; body: unknown; headers: Record<string, string> } = {
    status: 0,
    body: null,
    headers: {},
  };
  const res = {
    setHeader(name: string, value: number | string | readonly string[]): Response {
      captured.headers[name] = String(value);
      return undefined as unknown as Response;
    },
    status(code: number): Response {
      captured.status = code;
      return res as unknown as Response;
    },
    json(body: unknown): Response {
      captured.body = body;
      return res as unknown as Response;
    },
  };
  const req = traceId === undefined ? ({} as Request) : ({ traceId } as unknown as Request);
  const host = {
    switchToHttp(): {
      getRequest(): Request;
      getResponse(): Response;
    } {
      return {
        getRequest: () => req,
        getResponse: () => res as unknown as Response,
      };
    },
  } as unknown as ArgumentsHost;
  return { host, captured };
}

describe('QuantErrorFilter', () => {
  const filter = new QuantErrorFilter();

  it('maps a STOCK_NOT_FOUND QuantError to HTTP 404 with the trace_id', () => {
    const { host, captured } = makeHost('tid-1');
    filter.catch(new QuantError('STOCK_NOT_FOUND', 'no such stock', { code: '999' }), host);
    expect(captured.status).toBe(404);
    expect(captured.headers[TRACE_HEADER]).toBe('tid-1');
    expect(captured.body).toEqual({
      code: 'STOCK_NOT_FOUND',
      message: 'no such stock',
      trace_id: 'tid-1',
      details: { code: '999' },
    });
  });

  it('maps an INVALID_ARGUMENT QuantError to HTTP 400', () => {
    const { host, captured } = makeHost('tid-2');
    filter.catch(new QuantError('INVALID_ARGUMENT', 'bad input'), host);
    expect(captured.status).toBe(400);
  });

  it('falls back to 500 + masked message for non-QuantError exceptions', () => {
    const { host, captured } = makeHost('tid-3');
    filter.catch(new Error('database password = secret'), host);
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({
      code: 'INTERNAL',
      message: 'internal server error',
      trace_id: 'tid-3',
      details: {},
    });
  });

  it('handles non-Error throws (string)', () => {
    const { host, captured } = makeHost('tid-4');
    filter.catch('boom', host);
    expect(captured.status).toBe(500);
  });

  it('uses an empty trace_id when no middleware ran', () => {
    const { host, captured } = makeHost(undefined);
    filter.catch(new QuantError('NOT_FOUND', 'gone'), host);
    expect(captured.headers[TRACE_HEADER]).toBe('');
    const body = captured.body as { trace_id: string };
    expect(body.trace_id).toBe('');
  });
});
