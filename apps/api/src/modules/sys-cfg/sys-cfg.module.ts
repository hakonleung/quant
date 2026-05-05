import { Module } from '@nestjs/common';

import { SysCfgController } from './sys-cfg.controller.js';
import { SYS_CFG_DATA_DIR, SysCfgStore } from './sys-cfg.store.js';

const DEFAULT_DATA_DIR = '../../data/sys-cfg';

@Module({
  controllers: [SysCfgController],
  providers: [
    {
      provide: SYS_CFG_DATA_DIR,
      useFactory: (): string => process.env['QUANT_SYS_CFG_DIR'] ?? DEFAULT_DATA_DIR,
    },
    SysCfgStore,
  ],
  exports: [SysCfgStore],
})
export class SysCfgModule {}
