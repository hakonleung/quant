/**
 * Adapter for {@link WatchKlineRefPort} backed by the local
 * `KlineReaderService`. Pulls the trailing 21 daily bars for one
 * A-share code and converts the precomputed `ma5/ma10/ma20` plus the
 * close prices at positions `[L-5, L-10, L-20]` into a `KlineMaRef`.
 *
 * Replaces the legacy `FlightKlineRefAdapter` once Python stops owning
 * kline persistence (plan §3.3 — Phase 2). The shape and semantics are
 * identical so the scheduler's behaviour does not change.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';

import { KlineReaderService } from '../kline/kline-reader.service.js';
import type { KlineMaRef } from './domain/evaluate.js';
import type { WatchKlineRefPort } from './domain/watch-port.js';

const MA_LOOKBACK = 21;

@Injectable()
export class LocalKlineRefAdapter implements WatchKlineRefPort {
  private readonly logger = new Logger(LocalKlineRefAdapter.name);

  constructor(@Inject(KlineReaderService) private readonly reader: KlineReaderService) {}

  async loadMaRef(code: string, traceId: string): Promise<KlineMaRef | null> {
    let bars;
    try {
      bars = await this.reader.lastNForCode(code, MA_LOOKBACK);
    } catch (err) {
      this.logger.warn(
        `watch_kline_ref_fail code=${code} trace_id=${traceId} err=${String(err)}`,
      );
      return null;
    }
    if (bars.length < MA_LOOKBACK) return null;
    const latest = bars[bars.length - 1];
    if (latest === undefined) return null;
    const { ma5, ma10, ma20 } = latest;
    if (ma5 === null || ma10 === null || ma20 === null) return null;
    // close `N` rows back from latest inclusive → index `bars.length - N`.
    // With length=21, ma20 falls back to bars[1].
    const drop5 = bars[bars.length - 5];
    const drop10 = bars[bars.length - 10];
    const drop20 = bars[bars.length - 20];
    if (drop5 === undefined || drop10 === undefined || drop20 === undefined) return null;
    return {
      ma: {
        ma5: new Decimal(ma5),
        ma10: new Decimal(ma10),
        ma20: new Decimal(ma20),
      },
      dropClose: {
        ma5: new Decimal(drop5.close),
        ma10: new Decimal(drop10.close),
        ma20: new Decimal(drop20.close),
      },
    };
  }
}
