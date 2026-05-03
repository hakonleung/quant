/**
 * Composition root for the sentiment feature
 * (modules/06-sentiment-analysis.md + modules/07-frontend.md §4.2).
 *
 * Owns its own Flight channel — separate from kline / stock-meta — so a
 * long-running LLM call cannot head-of-line block other reads.
 */

import { Module } from '@nestjs/common';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { SentimentController } from './sentiment.controller.js';
import { SENTIMENT_FLIGHT_CLIENT } from './sentiment.token.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  controllers: [SentimentController],
  providers: [
    {
      provide: SENTIMENT_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
  ],
})
export class SentimentModule {}
