/**
 * Composition root for the technical-analysis (beta) feature.
 *
 * Owns its own Flight channel — separate from sentiment / kline — so a
 * long-running Kimi call doesn't block other reads.
 */

import { Module } from '@nestjs/common';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { TaController } from './ta.controller.js';
import { TA_FLIGHT_CLIENT } from './ta.token.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  controllers: [TaController],
  providers: [
    {
      provide: TA_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
  ],
})
export class TaModule {}
