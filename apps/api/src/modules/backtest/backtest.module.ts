/**
 * Composition root for screen-signal backtesting. Owns its own Flight
 * channel so a long evaluate run does not head-of-line block other
 * Python-bound traffic (pattern, blacklist, financials).
 */

import { Module } from '@nestjs/common';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { KlineModule } from '../kline/kline.module.js';
import { ScreenModule } from '../screen/screen.module.js';
import { BacktestController } from './backtest.controller.js';
import { BacktestService } from './backtest.service.js';
import { BACKTEST_FLIGHT_CLIENT } from './backtest.token.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  imports: [KlineModule, ScreenModule],
  controllers: [BacktestController],
  providers: [
    BacktestService,
    {
      provide: BACKTEST_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
  ],
})
export class BacktestModule {}
