/**
 * Placeholder UI routes (modules/07-frontend.md).
 *
 * v1 status:
 *   - kline reads → ``KlineModule`` (do not re-implement here)
 *   - sentiment GET/POST analyze_one + analyze_many → ``SentimentModule``
 *   - sector hits aggregator: still pending — keeps a stub returning
 *     `[]` so the BFF/UI render an empty state cleanly.
 */

import { Controller, Get, Query } from '@nestjs/common';
import type { BlotterRow } from '@quant/shared';

@Controller()
export class UiController {
  // TODO(py): merge `screening` and `sectors` results once the Python service
  //   implements union/intersection.
  @Get('sectors/hits')
  listSectorHits(@Query('ids') _ids: string): readonly BlotterRow[] {
    return [];
  }
}
