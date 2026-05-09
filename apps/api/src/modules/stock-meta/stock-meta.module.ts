/**
 * Composition root for the stock-meta feature. Reads the Flight target
 * from `QUANT_FLIGHT_TARGET` (defaults to local dev), constructs the
 * `FlightClient` once, and binds it as the {@link FLIGHT_CLIENT}
 * provider. The controller depends on `StockMetaService`, which in turn
 * depends on the {@link STOCK_META_PORT}.
 *
 * FlightClient lifetime: the channel is opened lazily by `@grpc/grpc-js`
 * on first call and torn down when the process exits. We don't wire an
 * explicit shutdown hook — the channel is idle-cheap, and Nest's
 * shutdown sequence does not block on background gRPC sockets.
 */

import { Module } from '@nestjs/common';
import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { OrchestrationModule } from '../orchestration/orchestration.module.js';
import { STOCK_META_PORT } from './domain/stock-meta-port.js';
import { FLIGHT_CLIENT, FlightStockMetaAdapter } from './flight-stock-meta.adapter.js';
import { FocusInstructionHandler } from './instructions/focus.handler.js';
import { StockInstructionHandler } from './instructions/stock.handler.js';
import { StockMetaController } from './stock-meta.controller.js';
import { StockMetaService } from './stock-meta.service.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  imports: [OrchestrationModule],
  controllers: [StockMetaController],
  providers: [
    {
      provide: FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
    { provide: STOCK_META_PORT, useClass: FlightStockMetaAdapter },
    SYSTEM_CLOCK_PROVIDER,
    StockMetaService,
    FocusInstructionHandler,
    StockInstructionHandler,
  ],
  exports: [StockMetaService],
})
export class StockMetaModule {}
