import { Module } from '@nestjs/common';

import { SysCfgController } from './sys-cfg.controller.js';
import { SysCfgStore } from './sys-cfg.store.js';

@Module({
  controllers: [SysCfgController],
  providers: [SysCfgStore],
  exports: [SysCfgStore],
})
export class SysCfgModule {}
