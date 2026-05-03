/**
 * Meta worker — drains the meta queue (`docs/modules/09-update-orchestration.md` §6.1).
 *
 * Calls the Python `enrich_stock_meta_for_code` op for `enrich` jobs and
 * `sync_stock_meta_full` for `full_sync`. On `RATE_LIMITED` /
 * `SOURCE_UNAVAILABLE` the job is rescheduled with exponential backoff
 * rather than failed (so transient upstream issues don't poison the queue).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { QuantError } from '@quant/shared';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { ORCH_FLIGHT_CLIENT } from './flight.token.js';
import { ExponentialBackoff } from './domain/backoff.js';
import type { JobEnvelope, JobProcessor, MetaJob, ReQueue } from './domain/types.js';

const TRANSIENT = new Set(['RATE_LIMITED', 'SOURCE_UNAVAILABLE']);

@Injectable()
export class MetaWorker implements JobProcessor<MetaJob> {
  private readonly logger = new Logger(MetaWorker.name);
  private readonly backoff = new ExponentialBackoff({
    baseMs: 1_000,
    factor: 2,
    maxMs: 5 * 60_000,
    jitterRatio: 0.2,
  });

  constructor(@Inject(ORCH_FLIGHT_CLIENT) private readonly flight: FlightClient) {}

  async process(job: JobEnvelope<MetaJob>, queue: ReQueue<MetaJob>): Promise<void> {
    try {
      if (job.data.kind === 'enrich') {
        await this.flight.doGet(
          'enrich_stock_meta_for_code',
          { code: job.data.code },
          { traceId: job.data.traceId },
        );
      } else {
        await this.flight.doGet('sync_stock_meta_full', {}, { traceId: job.data.traceId });
      }
    } catch (err) {
      if (err instanceof QuantError && TRANSIENT.has(err.code)) {
        const delay = this.backoff.next(job.attemptsMade);
        this.logger.warn(
          `meta_job_transient_failure id=${job.id} code=${err.code} attempt=${String(job.attemptsMade)} delayMs=${String(delay)}`,
        );
        queue.reschedule(job, delay);
        return;
      }
      this.logger.error(
        `meta_job_failed id=${job.id} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
