/**
 * K-line worker (`docs/modules/09-update-orchestration.md` §5, §6.2).
 *
 * - Token bucket caps Flight calls at ~4 req/s with burst 8.
 * - On `RATE_LIMITED` / `SOURCE_UNAVAILABLE`: reschedule the job with
 *   exponential backoff (5s → 15min cap) instead of failing it.
 * - 1-minute window: if ≥ 30% of recent attempts hit RATE_LIMITED, the
 *   queue is paused for 5 minutes (caller pauses; this class only emits
 *   the signal via `shouldTrip()`).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { QuantError } from '@quant/shared';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { ORCH_FLIGHT_CLIENT, KLINE_QUEUE } from './flight.token.js';
import { ExponentialBackoff } from './domain/backoff.js';
import { TokenBucket } from './domain/rate-limiter.js';
import type { InMemoryQueue } from './domain/in-memory-queue.js';
import type { JobEnvelope, JobProcessor, KlineJob, ReQueue } from './domain/types.js';

const TRANSIENT = new Set(['RATE_LIMITED', 'SOURCE_UNAVAILABLE']);
const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_THRESHOLD = 0.3;
const CIRCUIT_PAUSE_MS = 5 * 60_000;
const CIRCUIT_MIN_SAMPLES = 10;

interface Sample {
  readonly t: number;
  readonly limited: boolean;
}

@Injectable()
export class KlineWorker implements JobProcessor<KlineJob> {
  private readonly logger = new Logger(KlineWorker.name);
  private readonly bucket = new TokenBucket({ ratePerSec: 4, burst: 8 });
  private readonly backoff = new ExponentialBackoff({
    baseMs: 5_000,
    factor: 2,
    maxMs: 15 * 60_000,
    jitterRatio: 0.2,
  });
  private samples: Sample[] = [];

  constructor(
    @Inject(ORCH_FLIGHT_CLIENT) private readonly flight: FlightClient,
    @Inject(KLINE_QUEUE) private readonly queue: InMemoryQueue<KlineJob>,
  ) {}

  async process(job: JobEnvelope<KlineJob>, queue: ReQueue<KlineJob>): Promise<void> {
    await this.bucket.acquire();
    try {
      await this.flight.doGet(
        'sync_kline_for_code',
        { code: job.data.code, trace_id: job.data.traceId },
        { traceId: job.data.traceId, deadlineMs: 30_000 },
      );
      this.recordSample(false);
    } catch (err) {
      if (err instanceof QuantError && TRANSIENT.has(err.code)) {
        this.recordSample(err.code === 'RATE_LIMITED');
        const delay = this.backoff.next(job.attemptsMade);
        this.logger.warn(
          `kline_job_transient code=${job.data.code} err=${err.code} attempt=${String(job.attemptsMade)} delayMs=${String(delay)}`,
        );
        queue.reschedule(job, delay);
        this.maybeTripCircuit();
        return;
      }
      this.recordSample(false);
      this.logger.error(
        `kline_job_failed code=${job.data.code} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private recordSample(limited: boolean): void {
    const now = Date.now();
    this.samples.push({ t: now, limited });
    const cutoff = now - CIRCUIT_WINDOW_MS;
    this.samples = this.samples.filter((s) => s.t >= cutoff);
  }

  private maybeTripCircuit(): void {
    if (this.queue.isPaused) return;
    if (this.samples.length < CIRCUIT_MIN_SAMPLES) return;
    const limited = this.samples.filter((s) => s.limited).length;
    const ratio = limited / this.samples.length;
    if (ratio >= CIRCUIT_THRESHOLD) {
      this.logger.warn(
        `kline_circuit_tripped ratio=${ratio.toFixed(2)} pausingMs=${String(CIRCUIT_PAUSE_MS)}`,
      );
      this.queue.pause();
      setTimeout(() => {
        this.logger.log('kline_circuit_resumed');
        this.queue.resume();
      }, CIRCUIT_PAUSE_MS);
    }
  }
}
