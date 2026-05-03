/**
 * Composition root for the kline read feature
 * (modules/02-stock-kline.md + 07 §4.2). Lazily opens its own Flight
 * channel — separate from stock-meta's so a stuck call on one feature
 * doesn't head-of-line block the other.
 */

import { Module } from '@nestjs/common';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { KlineController } from './kline.controller.js';
import { KLINE_FLIGHT_CLIENT } from './kline.token.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  controllers: [KlineController],
  providers: [
    {
      provide: KLINE_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
  ],
})
export class KlineModule {}
