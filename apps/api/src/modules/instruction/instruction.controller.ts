/**
 * `POST /api/instructions/:id` — the FE→BE typed dispatch endpoint.
 *
 * The FE InstructionCenter (`feCenter`) calls this from each cell's
 * handler; the typed `ResultOf<I>` payload flows through HTTP and
 * lands directly in the FE cell's renderer without a translation
 * layer. Per-feature endpoints (`/api/sentiment/analyze_one`,
 * `/api/screen/run`, etc.) used to serve terminal commands; those
 * retire as cells migrate.
 *
 * Wire contract:
 *   - Body: the instruction's args (zod-validated against the
 *     manifest's `argsSchema` inside `executor.executeTyped`).
 *   - 200: raw `ResultOf<I>` payload (no envelope wrap — HTTP status
 *     carries ok/err).
 *   - 400 / 403 / 404 / 422: `{ code, message }` matching the
 *     `InstructionErrorCode` union.
 *
 * Async-mode instructions (`/analyze`, `/ta`, `/screen`, ...) still
 * route through BullMQ via `executor.dispatch` separately — that
 * surface stays the IM listener's. The HTTP endpoint runs handlers
 * **inline** (matches the legacy `executeHandler` semantics) because
 * the FE shell can't wait for a BullMQ completion through HTTP.
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { InstructionDispatchError } from '@quant/shared';

import { type RequestWithTraceId } from '../../common/trace.middleware.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/request-with-user.js';

import { InstructionExecutor } from './instruction.executor.js';
import type { InstructionCtx } from './instruction.port.js';

@Controller('instructions')
export class InstructionController {
  constructor(@Inject(InstructionExecutor) private readonly executor: InstructionExecutor) {}

  @Post(':id')
  @HttpCode(200)
  async invoke(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: RequestWithTraceId,
  ): Promise<unknown> {
    const ctx: InstructionCtx = {
      traceId: req.traceId,
      source: 'http',
      userId: user.id,
    };
    const args = (body ?? {}) as Record<string, unknown>;
    try {
      return await this.executor.executeTyped(id, args, ctx);
    } catch (err) {
      if (err instanceof InstructionDispatchError) {
        throw mapDispatchError(err);
      }
      throw err;
    }
  }
}

/**
 * Map cell error codes to HTTP status. Stays narrow so the FE shell
 * can build an `InstructionEnvelope`-shape error from the JSON body
 * regardless of which non-2xx fired.
 */
function mapDispatchError(err: InstructionDispatchError): Error {
  const body = { code: err.code, message: err.message };
  switch (err.code) {
    case 'not-found':
      return new NotFoundException(body);
    case 'forbidden':
    case 'confirm-required':
      return new ForbiddenException(body);
    case 'validation':
    case 'parse':
      return new BadRequestException(body);
    case 'handler':
    default:
      return new InternalServerErrorException(body);
  }
}
