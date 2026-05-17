/**
 * Persistent queue + in-process completion bus for async instructions
 * (`InstructionSpec.mode === 'async'`).
 *
 * Why split bus / processor:
 *   - `InstructionExecutor.executeAsync` enqueues a job and returns the
 *     `jobId` synchronously (so the IM listener can echo a "started"
 *     reply). It must not import the worker.
 *   - The processor (`InstructionAsyncProcessor`) drains jobs and emits
 *     completion events through this bus. Subscribers (the IM listener)
 *     forward them to their original IM channel.
 *
 * BullMQ vs EventEmitter:
 *   - BullMQ owns durability + restart safety (Redis-backed; jobs survive
 *     a worker crash up to `attempts`).
 *   - EventEmitter2 owns same-process completion broadcast. We don't push
 *     completion through Redis since both the producer (executor) and
 *     consumer (IM listener) live in the API process. If/when a separate
 *     worker process is introduced, swap to a Redis pubsub here.
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ServerConfigCenter } from '@quant/config/server';
import {
  type ChannelId,
  type InstructionAsyncCompletedPayload,
  type InstructionAsyncStartedPayload,
} from '@quant/shared';
import { Queue, type JobsOptions } from 'bullmq';

import type { InstructionCtx } from '../instruction.port.js';

export const INSTRUCTION_ASYNC_QUEUE = 'instruction.async';
export const INSTRUCTION_ASYNC_STARTED_EVENT = 'instruction.async.started';
export const INSTRUCTION_ASYNC_COMPLETED_EVENT = 'instruction.async.completed';

/**
 * IM continuation hints captured at enqueue time. The processor needs
 * these to push the "completed" card back to the original channel; they
 * cannot be re-derived after the fact (the IM message has already been
 * acknowledged on the listener side).
 */
export interface InstructionImHints {
  readonly channel: ChannelId;
  readonly target: string;
}

export interface InstructionAsyncJob {
  readonly jobId: string;
  readonly instructionId: string;
  readonly rawArgs: Record<string, unknown>;
  readonly ctx: InstructionCtx;
  readonly im?: InstructionImHints;
  readonly enqueuedAt: string;
}

@Injectable()
export class InstructionAsyncBus {
  private readonly logger = new Logger(InstructionAsyncBus.name);

  constructor(
    @InjectQueue(INSTRUCTION_ASYNC_QUEUE) private readonly queue: Queue<InstructionAsyncJob>,
    @Inject(EventEmitter2) private readonly emitter: EventEmitter2,
  ) {}

  async enqueue(job: InstructionAsyncJob): Promise<void> {
    const cfg = ServerConfigCenter.get().instruction.async;
    const opts: JobsOptions = {
      attempts: cfg.attempts,
      removeOnComplete: cfg.removeOnComplete,
      removeOnFail: cfg.removeOnFail,
      jobId: job.jobId,
    };
    await this.queue.add(job.instructionId, job, opts);
    this.logger.log(
      `instruction_async_enqueued id=${job.instructionId} jobId=${job.jobId} userId=${job.ctx.userId}`,
    );
  }

  emitStarted(payload: InstructionAsyncStartedPayload): void {
    this.emitter.emit(INSTRUCTION_ASYNC_STARTED_EVENT, payload);
  }

  emitCompleted(payload: InstructionAsyncCompletedPayload): void {
    this.emitter.emit(INSTRUCTION_ASYNC_COMPLETED_EVENT, payload);
  }
}
