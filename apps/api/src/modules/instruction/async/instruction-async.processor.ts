/**
 * Drains `instruction.async` jobs:
 *   1. Emit `instruction.async.started` (socket → user; bus → IM listener).
 *   2. Run the handler via `InstructionExecutor.execute` (sync path —
 *      args have already been zod-validated by `executeAsync`).
 *   3. Emit `instruction.async.completed` with the result + duration.
 *
 * BullMQ retries are disabled (attempts=1) on purpose — long-running LLM
 * ops own their own deadline / retry semantics; a generic exponential
 * backoff would just stack identical paid calls.
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import {
  errResult,
  type InstructionAsyncCompletedPayload,
  type InstructionAsyncStartedPayload,
  type InstructionResult,
} from '@quant/shared';
import { type Job } from 'bullmq';

import { CLOCK, type Clock } from '../../../common/clock.js';
import { SocketBus } from '../../socket/socket-bus.service.js';
import { InstructionExecutor } from '../instruction.executor.js';
import {
  InstructionAsyncBus,
  INSTRUCTION_ASYNC_QUEUE,
  type InstructionAsyncJob,
} from './instruction-async.bus.js';

@Processor(INSTRUCTION_ASYNC_QUEUE)
export class InstructionAsyncProcessor extends WorkerHost {
  private readonly logger = new Logger(InstructionAsyncProcessor.name);

  constructor(
    @Inject(InstructionExecutor) private readonly executor: InstructionExecutor,
    @Inject(InstructionAsyncBus) private readonly bus: InstructionAsyncBus,
    @Inject(SocketBus) private readonly sockets: SocketBus,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  async process(job: Job<InstructionAsyncJob>): Promise<{ ok: boolean }> {
    const data = job.data;
    const startInstant = this.clock.now();

    const startedPayload: InstructionAsyncStartedPayload = {
      jobId: data.jobId,
      instructionId: data.instructionId,
      userId: data.ctx.userId,
      startedAt: startInstant.toISOString(),
    };
    this.sockets.emitTo(data.ctx.userId, 'instruction.async.started', startedPayload);
    this.bus.emitStarted(startedPayload);

    let result: InstructionResult;
    try {
      // CRITICAL: must call executeHandler (not execute / dispatch) here.
      // Async-mode instructions routed through `route()` re-enqueue another
      // BullMQ job, leaving the user with the "▶ /id queued" ack forever
      // and the handler never running. executeHandler bypasses async
      // routing and runs the handler inline.
      result = await this.executor.executeHandler(data.instructionId, data.rawArgs, data.ctx);
    } catch (err) {
      // executeHandler already wraps handler throws as errResult, so an
      // exception here means executor itself crashed (registry race etc).
      this.logger.error(
        `instruction_async_executor_throw id=${data.instructionId} jobId=${data.jobId} err=${String(err)}`,
      );
      result = errResult('handler', err instanceof Error ? err.message : String(err));
    }

    const finishedInstant = this.clock.now();
    const completedPayload: InstructionAsyncCompletedPayload = {
      jobId: data.jobId,
      instructionId: data.instructionId,
      userId: data.ctx.userId,
      result,
      finishedAt: finishedInstant.toISOString(),
      durationMs: Math.max(0, finishedInstant.getTime() - startInstant.getTime()),
    };
    this.sockets.emitTo(data.ctx.userId, 'instruction.async.completed', completedPayload);
    this.bus.emitCompleted(completedPayload);

    return { ok: result.ok };
  }
}
