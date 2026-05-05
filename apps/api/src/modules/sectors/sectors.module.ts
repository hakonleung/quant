import { Module } from '@nestjs/common';

import { SectorsController } from './sectors.controller.js';
import { SECTORS_DATA_DIR, SectorsStore } from './sectors.store.js';

const DEFAULT_DATA_DIR = '../../data/sectors';

@Module({
  controllers: [SectorsController],
  providers: [
    {
      provide: SECTORS_DATA_DIR,
      useFactory: (): string => process.env['QUANT_SECTORS_DIR'] ?? DEFAULT_DATA_DIR,
    },
    SectorsStore,
  ],
  exports: [SectorsStore],
})
export class SectorsModule {}
