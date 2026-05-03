/**
 * Composition root for the 105 pattern-match feature
 * (modules/04-pattern-matching.md). Owns its own Flight channel so a
 * long-running DTW scan cannot head-of-line block other reads.
 */

import { Module } from '@nestjs/common';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { PatternController } from './pattern.controller.js';
import { PATTERN_FLIGHT_CLIENT } from './pattern.token.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  controllers: [PatternController],
  providers: [
    {
      provide: PATTERN_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
  ],
})
export class PatternModule {}
