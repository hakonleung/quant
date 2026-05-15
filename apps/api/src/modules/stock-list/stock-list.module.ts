/**
 * Composition root for the stock-list assemble surface — owns the
 * single endpoint that returns fully-stitched `StockListRow[]` to the
 * FE list pane and the IM table renderers.
 */

import { Module } from '@nestjs/common';

import { KlineModule } from '../kline/kline.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { StockListController } from './stock-list.controller.js';
import { StockListService } from './stock-list.service.js';

@Module({
  imports: [StockMetaModule, KlineModule],
  controllers: [StockListController],
  providers: [StockListService],
  exports: [StockListService],
})
export class StockListModule {}
