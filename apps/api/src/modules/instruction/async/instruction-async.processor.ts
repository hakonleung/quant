/**
 * Drains `instruction.async` jobs:
 *   1. Emit `instruction.async.started` (socket → user; bus → other subscribers).
 *   2. Run the handler via `InstructionExecutor.executeHandler` (sync path —
 *      args have already been zod-validated by `executeAsync`).
 *   3. Emit `instruction.async.completed` with the result + duration.
 *   4. If the job carries `im` hints (channel + target), push the result
 *      card directly to that IM thread via `ChannelService`.
 *
 * Why the processor owns IM delivery (and not a separate listener):
 *   - The in-process completion event used to be bridged through
 *     `InstructionImListener.pendingByJobId`, populated *after* the
 *     `executor.dispatch` await resolved. Fast jobs (cache hits in
 *     `/ta`, `/analyze`, `/screen`, …) could win the race and emit the
 *     completion before the listener registered, so the result was
 *     silently dropped. The bridge also evaporated on process restart,
 *     losing any IM callback for jobs that survived in Redis.
 *   - The processor already holds the authoritative job data — including
 *     the `im` hints — so delivering inline is race-free and restart-safe.
 *
 * BullMQ retries are disabled (attempts=1) on purpose — long-running LLM
 * ops own their own deadline / retry semantics; a generic exponential
 * backoff would just stack identical paid calls.
 */

import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import {
  errResult,
  formatResult,
  type InstructionAsyncCompletedPayload,
  type InstructionAsyncStartedPayload,
  type InstructionResult,
} from '@quant/shared';
import { type Job } from 'bullmq';

import { CLOCK, type Clock } from '../../../common/clock.js';
import { ChannelService } from '../../channel/channel.service.js';
import { SocketBus } from '../../socket/socket-bus.service.js';
import { InstructionExecutor } from '../instruction.executor.js';
import {
  InstructionAsyncBus,
  INSTRUCTION_ASYNC_QUEUE,
  type InstructionAsyncJob,
  type InstructionImHints,
} from './instruction-async.bus.js';

@Processor(INSTRUCTION_ASYNC_QUEUE)
export class InstructionAsyncProcessor extends WorkerHost {
  private readonly logger = new Logger(InstructionAsyncProcessor.name);

  constructor(
    @Inject(InstructionExecutor) private readonly executor: InstructionExecutor,
    @Inject(InstructionAsyncBus) private readonly bus: InstructionAsyncBus,
    @Inject(SocketBus) private readonly sockets: SocketBus,
    @Inject(ChannelService) private readonly channels: ChannelService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  async process(job: Job<InstructionAsyncJob>): Promise<{ ok: boolean }> {
    const data = job.data;
    const startInstant = this.clock.now();
    this.logger.log(
      `dbg_async_process_enter id=${data.instructionId} jobId=${data.jobId} bullId=${String(job.id)} userId=${data.ctx.userId} hasIm=${String(data.im !== undefined)} traceId=${data.ctx.traceId}`,
    );

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
    this.logger.log(
      `dbg_async_handler_done id=${data.instructionId} jobId=${data.jobId} bullId=${String(job.id)} ok=${String(result.ok)} duration_ms=${String(completedPayload.durationMs)} hasIm=${String(data.im !== undefined)}`,
    );

    if (data.im !== undefined) {
      await this.deliverImReply(data.im, completedPayload, data.ctx.traceId);
    }

    return { ok: result.ok };
  }

  // ── BullMQ worker lifecycle taps ──────────────────────────────────────────
  // Each fires on the worker (not the queue) so we get the bullId of the job
  // this process actually held the lock for. The pair `process_enter` →
  // `wevent_completed`/`wevent_failed` should both fire for any job that
  // produced a result; `wevent_stalled` firing alone means BullMQ reclaimed
  // the job mid-handler (lock expired) and the user will get silence.
  @OnWorkerEvent('active')
  onActive(job: Job<InstructionAsyncJob>): void {
    this.logger.log(
      `dbg_wevent_active bullId=${String(job.id)} jobId=${job.data.jobId} id=${job.data.instructionId}`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<InstructionAsyncJob>): void {
    this.logger.log(
      `dbg_wevent_completed bullId=${String(job.id)} jobId=${job.data.jobId} id=${job.data.instructionId}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<InstructionAsyncJob> | undefined, err: Error): void {
    const bullId = job === undefined ? '-' : String(job.id);
    const jobId = job === undefined ? '-' : job.data.jobId;
    const id = job === undefined ? '-' : job.data.instructionId;
    this.logger.error(
      `dbg_wevent_failed bullId=${bullId} jobId=${jobId} id=${id} err=${err.message}`,
    );
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`dbg_wevent_stalled bullId=${jobId}`);
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.logger.error(`dbg_wevent_error err=${err.message}`);
  }

  private async deliverImReply(
    im: InstructionImHints,
    payload: InstructionAsyncCompletedPayload,
    traceId: string,
  ): Promise<void> {
    // Forward handler-side `output.meta` (e.g. `stockTableRows`) the same
    // way the sync path does so async screen / TA results render through
    // the native Feishu table when the handler emits one.
    const handlerMeta =
      payload.result.ok && payload.result.output.meta !== undefined
        ? payload.result.output.meta
        : undefined;
    this.logger.log(
      `dbg_async_im_send_begin channel=${im.channel} target=${im.target} jobId=${payload.jobId} id=${payload.instructionId} ok=${String(payload.result.ok)}`,
    );
    try {
      await this.channels.send(
        im.channel,
        {
          text: formatResult(payload.result),
          kind: 'instruction.async.completed',
          target: im.target,
          meta: {
            ok: payload.result.ok,
            instructionId: payload.instructionId,
            jobId: payload.jobId,
            durationMs: payload.durationMs,
            ...(payload.result.ok ? {} : { code: payload.result.error.code }),
            ...(handlerMeta ?? {}),
          },
        },
        { traceId, source: 'system' },
      );
      this.logger.log(
        `dbg_async_im_send_ok channel=${im.channel} jobId=${payload.jobId} id=${payload.instructionId}`,
      );
    } catch (err) {
      this.logger.warn(
        `instruction_async_im_send_failed channel=${im.channel} jobId=${payload.jobId} err=${String(err)}`,
      );
    }
  }
}
