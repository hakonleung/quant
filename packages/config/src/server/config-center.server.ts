/**
 * ServerConfigCenter — env-agnostic config holder for Node processes.
 *
 * Callers (NestJS bootstrap, Next.js server) parse env themselves and
 * pass the resolved shape via {@link ServerConfigCenter.init}. The
 * package itself never reads `process.env`. Missing slots fall back to
 * the per-domain defaults exported alongside each schema.
 */

import { authConfig, type AuthConfig } from '../schemas/auth.schema.js';
import {
  cacheConfig,
  type CacheConfig,
  type CacheConfigOverrides,
} from '../schemas/cache.schema.js';
import {
  channelConfig,
  type ChannelConfig,
  type ChannelConfigOverrides,
} from '../schemas/channel.schema.js';
import { flightConfig, type FlightConfig } from '../schemas/flight.schema.js';
import {
  instructionConfig,
  type InstructionConfig,
  type InstructionConfigOverrides,
} from '../schemas/instruction.schema.js';
import {
  llmConfig,
  type LlmConfig,
  type LlmConfigOverrides,
} from '../schemas/llm.schema.js';
import {
  orchestrationConfig,
  type OrchestrationConfig,
  type OrchestrationConfigOverrides,
} from '../schemas/orchestration.schema.js';
import { serverConfig, type ServerConfig } from '../schemas/server.schema.js';
import {
  uiConfig,
  type UiConfig,
  type UiConfigOverrides,
} from '../schemas/ui.schema.js';
import { watchConfig, type WatchConfig } from '../schemas/watch.schema.js';

export interface ResolvedServerConfig {
  readonly auth: AuthConfig;
  readonly cache: CacheConfig;
  readonly channel: ChannelConfig;
  readonly flight: FlightConfig;
  readonly instruction: InstructionConfig;
  readonly llm: LlmConfig;
  readonly orchestration: OrchestrationConfig;
  readonly server: ServerConfig;
  readonly ui: UiConfig;
  readonly watch: WatchConfig;
}

export interface ServerConfigOverrides {
  readonly auth?: Partial<AuthConfig>;
  readonly cache?: CacheConfigOverrides;
  readonly channel?: ChannelConfigOverrides;
  readonly flight?: Partial<FlightConfig>;
  readonly instruction?: InstructionConfigOverrides;
  readonly llm?: LlmConfigOverrides;
  readonly orchestration?: OrchestrationConfigOverrides;
  readonly server?: Partial<ServerConfig>;
  readonly ui?: UiConfigOverrides;
  readonly watch?: Partial<WatchConfig>;
}

function resolve(overrides: ServerConfigOverrides): ResolvedServerConfig {
  return {
    auth: authConfig(overrides.auth ?? {}),
    cache: cacheConfig(overrides.cache ?? {}),
    channel: channelConfig(overrides.channel ?? {}),
    flight: flightConfig(overrides.flight ?? {}),
    instruction: instructionConfig(overrides.instruction ?? {}),
    llm: llmConfig(overrides.llm ?? {}),
    orchestration: orchestrationConfig(overrides.orchestration ?? {}),
    server: serverConfig(overrides.server ?? {}),
    ui: uiConfig(overrides.ui ?? {}),
    watch: watchConfig(overrides.watch ?? {}),
  };
}

export class ServerConfigCenter {
  private static instance: ServerConfigCenter | null = null;

  private constructor(private readonly cfg: ResolvedServerConfig) {}

  /**
   * Initialise the singleton from explicit overrides. Idempotent: a
   * second call returns the existing instance unless `force` is true.
   *
   * Pass an empty object (or omit) to use defaults — useful in tests.
   */
  static init(
    overrides: ServerConfigOverrides = {},
    options: { readonly force?: boolean } = {},
  ): ServerConfigCenter {
    if (ServerConfigCenter.instance !== null && options.force !== true) {
      return ServerConfigCenter.instance;
    }
    ServerConfigCenter.instance = new ServerConfigCenter(resolve(overrides));
    return ServerConfigCenter.instance;
  }

  static get(): ServerConfigCenter {
    if (ServerConfigCenter.instance === null) {
      throw new Error('ServerConfigCenter not initialised — call init() at bootstrap');
    }
    return ServerConfigCenter.instance;
  }

  static __resetForTests(): void {
    ServerConfigCenter.instance = null;
  }

  get auth(): AuthConfig {
    return this.cfg.auth;
  }
  get cache(): CacheConfig {
    return this.cfg.cache;
  }
  get channel(): ChannelConfig {
    return this.cfg.channel;
  }
  get flight(): FlightConfig {
    return this.cfg.flight;
  }
  get instruction(): InstructionConfig {
    return this.cfg.instruction;
  }
  get llm(): LlmConfig {
    return this.cfg.llm;
  }
  get orchestration(): OrchestrationConfig {
    return this.cfg.orchestration;
  }
  get server(): ServerConfig {
    return this.cfg.server;
  }
  get ui(): UiConfig {
    return this.cfg.ui;
  }
  get watch(): WatchConfig {
    return this.cfg.watch;
  }

  snapshot(): ResolvedServerConfig {
    return this.cfg;
  }
}
