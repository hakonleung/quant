/**
 * Meta worker — drains the meta queue (`docs/modules/09-update-orchestration.md` §6.1).
 *
 * Processes a single `meta_pkg` envelope by running whichever sub-steps
 * the `needBasic` / `needFinancials` flags request, in order:
 *   1. `enrich_stock_meta_for_code` — basic info from XQ.
 *   2. `enrich_financials_for_code` — financials + pe/pb recompute.
 *
 * Retry / pool-backoff policy is owned by the queue (see
 * `OrchestrationModule`). Transient errors (`RATE_LIMITED`,
 * `SOURCE_UNAVAILABLE`) bubble out so the queue re-schedules with
 * `taskBackoff`. Pool-class errors (proxy / connect abort) trip the
 * pool-backoff lock independently.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { isAShareCode } from '@quant/shared';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { BlacklistStore } from '../blacklist/blacklist.store.js';
import { ORCH_FLIGHT_CLIENT } from './flight.token.js';
import type { JobEnvelope, JobProcessor, MetaJob, ReQueue } from './domain/types.js';

@Injectable()
export class MetaWorker implements JobProcessor<MetaJob> {
  private readonly logger = new Logger(MetaWorker.name);

  constructor(
    @Inject(ORCH_FLIGHT_CLIENT) private readonly flight: FlightClient,
    @Inject(BlacklistStore) private readonly blacklist: BlacklistStore,
  ) {}

  async process(job: JobEnvelope<MetaJob>, _queue: ReQueue<MetaJob>): Promise<void> {
    const { code, traceId, needBasic, needFinancials } = job.data;
    // Skip per-code meta work for blacklisted A-share codes — these
    // contribute no value to the workbench, and the cron re-evaluates
    // the blacklist daily so a code coming off the list rejoins the
    // work set automatically.
    if (isAShareCode(code) && this.blacklist.has(code)) {
      return;
    }
    if (needBasic) {
      await this.flight.doGet('enrich_stock_meta_for_code', { code }, { traceId });
    }
    if (needFinancials) {
      await this.flight.doGet('enrich_financials_for_code', { code }, { traceId });
    }
    this.logger.debug(
      `meta_pkg_done code=${code} basic=${String(needBasic)} financials=${String(needFinancials)} trace_id=${traceId}`,
    );
  }
}
