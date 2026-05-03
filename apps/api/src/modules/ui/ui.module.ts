/**
 * Hosts the placeholder UI-facing routes (modules/07-frontend.md). The
 * module is intentionally thin — once each Python service lands, lift
 * the corresponding route into a feature module of its own (e.g.
 * `MarketsModule`, `SentimentModule`).
 */

import { Module } from '@nestjs/common';

import { UiController } from './ui.controller.js';

@Module({
  controllers: [UiController],
})
export class UiModule {}
