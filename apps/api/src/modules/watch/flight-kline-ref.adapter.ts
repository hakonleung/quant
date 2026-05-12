/**
 * Adapter for {@link WatchKlineRefPort} backed by the Python Flight
 * service's `list_kline_for_code` op. Pulls the trailing 21 daily bars
 * for one A-share code and converts the precomputed `ma5/ma10/ma20`
 * plus the close prices at positions `[L-5, L-10, L-20]` into a
 * `KlineMaRef`.
 *
 * Returns `null` whenever the upstream returns fewer than 21 bars
 * (typically newly-listed names) so the scheduler can silently skip
 * MA evaluation rather than fail the whole tick.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { arrowTableToKlineBars } from '../kline/domain/arrow-mapper.js';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import type { KlineMaRef } from './domain/evaluate.js';
import type { WatchKlineRefPort } from './domain/watch-port.js';
import { WATCH_FLIGHT_CLIENT } from './flight-watch.adapter.js';

const MA_LOOKBACK = 21;

@Injectable()
export class FlightKlineRefAdapter implements WatchKlineRefPort {
  private readonly logger = new Logger(FlightKlineRefAdapter.name);

  constructor(@Inject(WATCH_FLIGHT_CLIENT) private readonly flight: FlightClient) {}

  async loadMaRef(code: string, traceId: string): Promise<KlineMaRef | null> {
    let bars;
    try {
      const result = await this.flight.doGet(
        'list_kline_for_code',
        { code, n: MA_LOOKBACK },
        { traceId },
      );
      bars = arrowTableToKlineBars(result.value);
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
    // drop close for window N = close `N` rows back from latest inclusive
    // → index `bars.length - N`. With length=21, ma20 falls back to bars[1].
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
