/**
 * In-process registry of `(InstructionSpec, InstructionHandler)` pairs.
 * Populated at boot by every feature module via the
 * `InstructionRegistrarBase` lifecycle hook.
 *
 * Aliases are stored alongside the canonical id so the IM and socket
 * paths can accept e.g. both `watch list` (subcommand-style, native to
 * the FE terminal) and `watch.list` (dotted-id style, native to IM
 * users).
 */

import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { assertHandlerCoverage, instructionId, type InstructionId } from '@quant/shared';

import { BeInstructionCenter } from '../instruction-center/be-instruction-center.service.js';

import type { AnyInstructionHandler, InstructionHandler } from './instruction.port.js';
import type { AnyInstructionSpec, InstructionSpec } from './instruction.types.js';

export interface InstructionEntry {
  readonly spec: AnyInstructionSpec;
  readonly handler: AnyInstructionHandler;
}

@Injectable()
export class InstructionRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(InstructionRegistry.name);
  private readonly byId = new Map<string, InstructionEntry>();
  /** ASCII aliases (InstructionId-validated), e.g. `watch.list → watch`. */
  private readonly aliasOf = new Map<string, string>();
  /** Free-form IM aliases (Chinese, etc.) → canonical id. */
  private readonly imAliasOf = new Map<string, string>();

  constructor(
    @Optional()
    @Inject(BeInstructionCenter)
    private readonly center: BeInstructionCenter | null = null,
  ) {}

  register<TArgs>(spec: InstructionSpec<TArgs>, handler: InstructionHandler<TArgs>): void {
    const id = spec.id;
    if (this.byId.has(id)) {
      throw new Error(`duplicate instruction id: ${String(id)}`);
    }
    // Method bivariance lets a `InstructionHandler<TArgs>` widen to
    // `AnyInstructionHandler = InstructionHandler<unknown>`. The
    // executor restores the typing by zod-parsing args before calling.
    const entry: InstructionEntry = { spec, handler };
    this.byId.set(id, entry);
    for (const alias of spec.aliases ?? []) {
      if (this.aliasOf.has(alias) || this.byId.has(alias)) {
        throw new Error(`duplicate instruction alias: ${String(alias)}`);
      }
      this.aliasOf.set(alias, id);
    }
    for (const alias of spec.imAliases ?? []) {
      if (this.imAliasOf.has(alias) || this.aliasOf.has(alias) || this.byId.has(alias)) {
        throw new Error(`duplicate instruction im-alias: ${alias}`);
      }
      this.imAliasOf.set(alias, id);
    }
    this.logger.log(
      `instruction_registered id=${String(id)} aliases=${(spec.aliases ?? []).join(',')} imAliases=${(spec.imAliases ?? []).join(',')}`,
    );
  }

  get(id: string): InstructionEntry | undefined {
    const real = this.imAliasOf.get(id) ?? this.aliasOf.get(id) ?? id;
    return this.byId.get(real);
  }

  list(): readonly InstructionEntry[] {
    return [...this.byId.values()];
  }

  /**
   * Returns a map from every accepted token (canonical id, ASCII alias,
   * or IM human alias) to its canonical id. Used by `parseInstructionLine`.
   */
  knownIds(): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const id of this.byId.keys()) out.set(id, id);
    for (const [alias, canon] of this.aliasOf) out.set(alias, canon);
    for (const [alias, canon] of this.imAliasOf) out.set(alias, canon);
    return out;
  }

  resolveId(id: string): InstructionId | undefined {
    const real = this.imAliasOf.get(id) ?? this.aliasOf.get(id) ?? id;
    if (!this.byId.has(real)) return undefined;
    // `instructionId(...)` re-validates the string via the shared regex
    // before re-branding; cheaper than tracking branded keys end-to-end.
    return instructionId(real);
  }

  /**
   * Assert the registered handler set matches the shared manifest's
   * `supportedOn: 'be'` slice. Throws on mismatch (missing handler for
   * a manifest entry, or registered handler not in the manifest).
   *
   * Ids migrated to the new `BeInstructionCenter` count as registered
   * — they live in a different surface but still satisfy the
   * manifest's "BE must implement these" contract.
   */
  assertManifestCoverage(): void {
    const centerIds = this.center?.ids() ?? [];
    assertHandlerCoverage({
      side: 'be',
      registeredIds: [...this.byId.keys(), ...centerIds],
    });
  }

  /**
   * Runs after every feature module's `onModuleInit` has registered.
   * Fails boot loudly if the manifest and the live handler set drift —
   * the user's "explicit declaration of unsupported commands" rule.
   *
   * Contract tests boot Nest with a partial module set, so we warn
   * instead of throwing in `NODE_ENV=test`. Production always throws.
   */
  onApplicationBootstrap(): void {
    try {
      this.assertManifestCoverage();
      this.logger.log(`instruction_manifest_ok registered=${String(this.byId.size)}`);
    } catch (err: unknown) {
      if (process.env['NODE_ENV'] === 'test') {
        this.logger.warn(`instruction_manifest_drift (test-mode warn): ${String(err)}`);
        return;
      }
      this.logger.error(`instruction_manifest_drift: ${String(err)}`);
      throw err;
    }
  }
}
