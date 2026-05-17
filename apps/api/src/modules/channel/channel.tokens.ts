/**
 * DI token for the channel module. Lives outside `channel.module.ts`
 * so services / adapters can `@Inject(CHANNEL_CONFIG)` without the
 * service ↔ module import cycle.
 */

export const CHANNEL_CONFIG = Symbol('CHANNEL_CONFIG');
