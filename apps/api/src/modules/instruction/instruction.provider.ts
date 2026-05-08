/**
 * Base class that turns a handler into a self-registering Nest provider.
 * Subclasses declare `spec` (the typed `InstructionSpec<TArgs>`) and
 * `execute(args, ctx)`; `onModuleInit` registers the pair with the
 * global `InstructionRegistry`.
 *
 * Feature modules just list the concrete handler class in `providers`.
 *
 * A `@Instruction()` decorator + DiscoveryModule scan would be more
 * declarative; CLAUDE.md §2.5.2 Rule of Three says wait until ≥ 3
 * registration patterns appear.
 */

import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { InstructionResult } from '@quant/shared';

import type { InstructionCtx, InstructionHandler } from './instruction.port.js';
import { InstructionRegistry } from './instruction.registry.js';
import type { InstructionSpec } from './instruction.types.js';

@Injectable()
export abstract class InstructionRegistrarBase<TArgs>
  implements OnModuleInit, InstructionHandler<TArgs>
{
  abstract readonly spec: InstructionSpec<TArgs>;

  constructor(@Inject(InstructionRegistry) protected readonly registry: InstructionRegistry) {}

  onModuleInit(): void {
    this.registry.register(this.spec, this);
  }

  abstract execute(args: TArgs, ctx: InstructionCtx): Promise<InstructionResult>;
}
