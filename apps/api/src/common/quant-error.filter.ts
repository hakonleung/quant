/**
 * Maps {@link QuantError} into HTTP responses using the shared status
 * table (ipc-py-ts.md §4). Anything else is logged and surfaced as a
 * generic 500 with the trace_id so users can quote it back to support.
 */

import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { QuantError, ERROR_HTTP_STATUS, TRACE_HEADER } from '@quant/shared';
import type { RequestWithTraceId } from './trace.middleware.js';

interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly trace_id: string;
  readonly details: Readonly<Record<string, unknown>>;
}

@Catch()
export class QuantErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(QuantErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const traceId = (req as Partial<RequestWithTraceId>).traceId ?? '';
    res.setHeader(TRACE_HEADER, traceId);

    if (exception instanceof QuantError) {
      const status = ERROR_HTTP_STATUS[exception.code];
      const body: ErrorBody = {
        code: exception.code,
        message: exception.message,
        trace_id: traceId,
        details: exception.details,
      };
      this.logger.warn(
        `quant_error code=${exception.code} status=${String(status)} trace_id=${traceId} msg=${exception.message}`,
      );
      res.status(status).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const fromBody =
        typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      const code =
        typeof fromBody['code'] === 'string' ? (fromBody['code'] as string) : exception.name;
      const message =
        typeof fromBody['message'] === 'string'
          ? (fromBody['message'] as string)
          : exception.message;
      const details =
        typeof fromBody['details'] === 'object' && fromBody['details'] !== null
          ? (fromBody['details'] as Record<string, unknown>)
          : {};
      const body: ErrorBody = { code, message, trace_id: traceId, details };
      this.logger.warn(
        `http_error code=${code} status=${String(status)} trace_id=${traceId} msg=${message}`,
      );
      res.status(status).json(body);
      return;
    }

    // Unknown failure — never leak the original message to clients.
    const message = exception instanceof Error ? exception.message : String(exception);
    this.logger.error(`unhandled trace_id=${traceId} msg=${message}`);
    const body: ErrorBody = {
      code: 'INTERNAL',
      message: 'internal server error',
      trace_id: traceId,
      details: {},
    };
    res.status(500).json(body);
  }
}
