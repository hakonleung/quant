/**
 * Composition root for the screen feature
 * (modules/03-screening.md + modules/07-frontend.md §4.3.3).
 *
 * Owns its own Flight channel — separate from sentiment / kline — so a
 * long-running NL→DSL LLM translation cannot block other reads.
 */

import { Module } from '@nestjs/common';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { ScreenController } from './screen.controller.js';
import { SCREEN_FLIGHT_CLIENT } from './screen.token.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  controllers: [ScreenController],
  providers: [
    {
      provide: SCREEN_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
  ],
})
export class ScreenModule {}
