/**
 * `InstructionCenter` — the unified, declaratively-configured dispatcher
 * that replaces both the FE terminal `CommandRegistry` and the BE
 * `InstructionRegistry`. Same class, instantiated twice with per-side
 * `Env` types; the manifest in `manifest.ts` is the single source of
 * truth for what instructions exist and what their args/result shapes
 * are.
 *
 * Key design points (see `docs/modules/instruction-center.md` for the
 * full write-up; brief here):
 *
 * 1. **No `sides` field on the manifest.** Each consumer instantiates
 *    `InstructionCenter<Env, Excluded>` and passes its own `Excluded`
 *    id union — e.g. FE excludes `'ping' | 'channel.echo' | ...`, BE
 *    excludes `'clear' | 'cache' | 'focus' | ...`. The type system
 *    enforces the remaining ids exhaustively at config time; runtime
 *    `assertHandlerCoverage` is gone.
 *
 * 2. **Per-id strongly-typed args + result.** Each cell's handler is
 *    `(args: ArgsOf<I>, ctx: Env['ctx']) => Promise<ResultOf<I>>` and
 *    its renderer is `(envelope: Envelope<ResultOf<I>>, host: Env['host'])
 *    => Env['output']`. FE and BE diverge in implementation
 *    (`ctx.api.usrList(...)` vs `ctx.usrService.list(...)` etc.) but
 *    are forced into structural lockstep by the shared schema — a
 *    review against two configs reveals parity at a glance.
 *
 * 3. **Renderer always sees an envelope.** Tokenize-fail, args-invalid,
 *    handler-throw all bubble through the same `{ ok: false, error }`
 *    shape so the renderer is the only place that decides how errors
 *    surface (term red toast vs IM markdown bullet).
 *
 * 4. **No injected DI here.** `Env['ctx']` is whatever the consumer
 *    passes to `dispatch` / `invoke` — NestJS wires `BeCtx` from
 *    services, Next.js wires `FeCtx` from api client + zustand stores.
 *    The center never imports framework code.
 */

import type { z } from 'zod';

import { instructionId, InvalidInstructionIdError, type InstructionId } from './id.js';
import {
  COMMAND_MANIFEST,
  INSTRUCTION_MANIFEST,
  type CommandManifestEntry,
  type ManifestById,
} from './manifest.js';
import { ArgvParseError, parseArgv, tokenize, type ParsedArgv } from './parse.js';
import type { InstructionError, InstructionErrorCode } from './result.js';

// ────────────────────────────────────────────────────────────────────────
// Type derivations from the manifest
// ────────────────────────────────────────────────────────────────────────

/** All known instruction ids (literal union derived from the manifest). */
export type AllInstructionIds = keyof ManifestById & string;

/** Args type for one id, via the entry's `argsSchema` zod inference. */
export type ArgsOf<I extends AllInstructionIds> =
  ManifestById[I] extends { readonly argsSchema: infer A }
    ? A extends z.ZodTypeAny
      ? z.infer<A>
      : never
    : Record<string, never>;

/** Result type for one id, via the entry's `resultSchema` zod inference. */
export type ResultOf<I extends AllInstructionIds> =
  ManifestById[I] extends { readonly resultSchema: infer R }
    ? R extends z.ZodTypeAny
      ? z.infer<R>
      : never
    : never;

// ────────────────────────────────────────────────────────────────────────
// Envelope (success | error) given to renderers
// ────────────────────────────────────────────────────────────────────────

export type InstructionEnvelope<R> =
  | { readonly ok: true; readonly data: R }
  | { readonly ok: false; readonly error: InstructionError };

export class InstructionDispatchError extends Error {
  constructor(
    readonly code: InstructionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InstructionDispatchError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Env + Cell + Config
// ────────────────────────────────────────────────────────────────────────

/**
 * Per-side execution environment. Consumers define a type literal of
 * this shape (e.g. `type FeEnv = { ctx: FeCtx; host: TermHost; output:
 * TermOutput }`) and pass it as `InstructionCenter<FeEnv, ...>`.
 *
 *   - ctx    — handler dependency bag (api client / services / stores)
 *   - host   — renderer dependency bag (term writer / IM replier)
 *   - output — renderer return type (term widget union / IM payload)
 *
 * Note: handler and renderer are deliberately given different deps so
 * "where data comes from" and "where it gets shown" stay independently
 * auditable.
 */
export interface InstructionEnv {
  readonly ctx: unknown;
  readonly host: unknown;
  readonly output: unknown;
}

export interface InstructionCell<E extends InstructionEnv, I extends AllInstructionIds> {
  /** Pure side effect + data fetch. Throws `InstructionDispatchError` on domain failure. */
  readonly handler: (args: ArgsOf<I>, ctx: E['ctx']) => Promise<ResultOf<I>>;
  /** Pure render: envelope (success or error) → side-specific output. */
  readonly renderer: (envelope: InstructionEnvelope<ResultOf<I>>, host: E['host']) => E['output'];
  /**
   * Optional IM paid-confirm bypass probe. Returns `true` when the
   * instruction can be served free (e.g. cache hit), letting the IM
   * gate skip the confirm card. Receives raw (pre-coercion) args so
   * cells can decide before going through zod. Failures should return
   * `false` (fail closed); the IM gate also catches throws.
   *
   * Only consulted when the manifest declares
   * `requiresImConfirm: true`. Cells without this hook are treated as
   * "no bypass — always show the card".
   */
  readonly peek?: (rawArgs: Record<string, unknown>, ctx: E['ctx']) => Promise<boolean>;
}

/**
 * Config map for `InstructionCenter`. Mapped type forces every id in
 * `(AllInstructionIds \ Excluded)` to have a cell — no missing entries,
 * no stray entries — entirely at compile time.
 */
export type InstructionConfig<E extends InstructionEnv, X extends AllInstructionIds> = {
  readonly [I in Exclude<AllInstructionIds, X>]: InstructionCell<E, I>;
};

// ────────────────────────────────────────────────────────────────────────
// Args coercion (manifest-driven zod parse)
// ────────────────────────────────────────────────────────────────────────

/**
 * Convert `(positional, flags)` into the object shape the manifest's
 * `argsSchema` expects, then zod-parse it. Today every existing
 * `argsSchema` is a plain object schema keyed by flag names — positional
 * args are unused — so we feed the flag map directly. When a future
 * instruction needs positional binding (e.g. `watch.add CODE GROUP`),
 * extend this with per-entry positional metadata on the manifest.
 */
export function coerceArgs<I extends AllInstructionIds>(
  id: I,
  argv: ParsedArgv,
): ArgsOf<I> {
  const entry: CommandManifestEntry | undefined = INSTRUCTION_MANIFEST[
    id as keyof ManifestById
  ] as CommandManifestEntry | undefined;
  if (entry === undefined) {
    throw new InstructionDispatchError('not-found', `unknown instruction: ${String(id)}`);
  }
  if (entry.argsSchema === undefined) {
    if (argv.positional.length > 0 || Object.keys(argv.flags).length > 0) {
      throw new InstructionDispatchError(
        'validation',
        `instruction ${String(id)} takes no arguments`,
      );
    }
    return {} as ArgsOf<I>;
  }
  const raw = { ...argv.flags };
  const parsed = entry.argsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InstructionDispatchError(
      'validation',
      parsed.error.issues
        .map((iss) => `${iss.path.join('.') || '<root>'}: ${iss.message}`)
        .join('; '),
    );
  }
  return parsed.data as ArgsOf<I>;
}

// ────────────────────────────────────────────────────────────────────────
// Alias / dotted-subcommand resolution
// ────────────────────────────────────────────────────────────────────────

interface AliasIndex {
  readonly canonical: ReadonlyMap<string, string>;
}

function buildAliasIndex(allowedIds: ReadonlySet<string>): AliasIndex {
  const canonical = new Map<string, string>();
  for (const entry of COMMAND_MANIFEST) {
    if (!allowedIds.has(entry.id)) continue;
    canonical.set(entry.id, entry.id);
    for (const a of entry.aliases ?? []) canonical.set(a, entry.id);
  }
  return { canonical };
}

/** Resolve `<head> [sub] [...]` into `(canonicalId, restTokens)`. */
function resolveHead(
  tokens: readonly string[],
  aliases: AliasIndex,
): { readonly id: string; readonly rest: readonly string[] } {
  if (tokens.length === 0) {
    throw new InstructionDispatchError('parse', 'empty instruction');
  }
  const head = tokens[0] as string;
  // Try dotted subcommand first: `sector show` → `sector.show`.
  if (tokens.length >= 2) {
    const sub = tokens[1] as string;
    const dotted = `${head}.${sub}`;
    const dottedCanonical = aliases.canonical.get(dotted);
    if (dottedCanonical !== undefined) {
      return { id: dottedCanonical, rest: tokens.slice(2) };
    }
  }
  const canonical = aliases.canonical.get(head);
  if (canonical === undefined) {
    throw new InstructionDispatchError('not-found', `unknown instruction: ${head}`);
  }
  return { id: canonical, rest: tokens.slice(1) };
}

// ────────────────────────────────────────────────────────────────────────
// InstructionCenter
// ────────────────────────────────────────────────────────────────────────

export interface InstructionCenterOptions {
  /**
   * If true, `dispatch` requires a leading `/`. The IM listener uses
   * this; the FE terminal passes false because it already lives behind
   * a prompt.
   */
  readonly requireSlashPrefix?: boolean;
}

export class InstructionCenter<
  E extends InstructionEnv,
  X extends AllInstructionIds = never,
> {
  private readonly cfg: InstructionConfig<E, X>;
  private readonly aliases: AliasIndex;
  private readonly requireSlashPrefix: boolean;

  constructor(cfg: InstructionConfig<E, X>, options: InstructionCenterOptions = {}) {
    this.cfg = cfg;
    const allowed = new Set<string>(Object.keys(cfg));
    this.aliases = buildAliasIndex(allowed);
    this.requireSlashPrefix = options.requireSlashPrefix === true;
  }

  /** Ids actually configured on this center (post-Excluded). */
  ids(): readonly Exclude<AllInstructionIds, X>[] {
    return Object.keys(this.cfg) as Exclude<AllInstructionIds, X>[];
  }

  has(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.cfg, id);
  }

  /** Direct invoke — bypasses tokenize/coerce; caller owns the args. */
  async invoke<I extends Exclude<AllInstructionIds, X>>(
    id: I,
    args: ArgsOf<I>,
    ctx: E['ctx'],
  ): Promise<ResultOf<I>> {
    const cell = this.cfg[id];
    return cell.handler(args, ctx);
  }

  /** Direct render — useful for proactive notifications that share a renderer. */
  render<I extends Exclude<AllInstructionIds, X>>(
    id: I,
    envelope: InstructionEnvelope<ResultOf<I>>,
    host: E['host'],
  ): E['output'] {
    const cell = this.cfg[id];
    return cell.renderer(envelope, host);
  }

  /**
   * Forward to the cell's optional `peek` hook. Returns `false` when
   * the cell has none (i.e. always show the IM confirm card).
   */
  async peek<I extends Exclude<AllInstructionIds, X>>(
    id: I,
    rawArgs: Record<string, unknown>,
    ctx: E['ctx'],
  ): Promise<boolean> {
    const cell = this.cfg[id];
    if (cell.peek === undefined) return false;
    return cell.peek(rawArgs, ctx);
  }

  /**
   * Parse + invoke + render. All failure modes (tokenize, alias resolution,
   * arg coercion, handler throw) end up as a `{ ok: false, error }`
   * envelope fed to the matched cell's renderer — or, when even the id
   * can't be resolved, to `options.fallbackRenderer` if provided. If no
   * fallback is set and id resolution fails, the underlying
   * `InstructionDispatchError` is re-thrown so the host can decide.
   */
  async dispatch(
    raw: string,
    ctx: E['ctx'],
    host: E['host'],
    options: { readonly fallbackRenderer?: (error: InstructionError) => E['output'] } = {},
  ): Promise<E['output']> {
    let id: Exclude<AllInstructionIds, X>;
    let argv: ParsedArgv;
    try {
      const stripped = this.stripPrefix(raw);
      const tokens = tokenize(stripped);
      const resolved = resolveHead(tokens, this.aliases);
      id = instructionId(resolved.id) as unknown as Exclude<AllInstructionIds, X>;
      if (!this.has(resolved.id)) {
        throw new InstructionDispatchError(
          'not-found',
          `instruction not configured on this center: ${resolved.id}`,
        );
      }
      argv = parseArgv(resolved.rest);
    } catch (err) {
      const error = toInstructionError(err);
      if (options.fallbackRenderer !== undefined) {
        return options.fallbackRenderer(error);
      }
      throw err;
    }

    try {
      const args = coerceArgs(id as AllInstructionIds, argv) as ArgsOf<typeof id>;
      const data = await this.cfg[id].handler(args, ctx);
      return this.cfg[id].renderer({ ok: true, data }, host);
    } catch (err) {
      const error = toInstructionError(err);
      return this.cfg[id].renderer({ ok: false, error }, host);
    }
  }

  private stripPrefix(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new InstructionDispatchError('parse', 'empty input');
    }
    if (trimmed.startsWith('/')) return trimmed.slice(1).trimStart();
    if (this.requireSlashPrefix) {
      throw new InstructionDispatchError('parse', 'missing leading `/`');
    }
    return trimmed;
  }
}

function toInstructionError(err: unknown): InstructionError {
  if (err instanceof InstructionDispatchError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof ArgvParseError) {
    return { code: 'parse', message: err.message };
  }
  if (err instanceof InvalidInstructionIdError) {
    return { code: 'parse', message: err.message };
  }
  return {
    code: 'handler',
    message: err instanceof Error ? err.message : String(err),
  };
}

/** Helper so consumers can re-export their canonical id union. */
export type InstructionIdsFor<C> = C extends InstructionCenter<infer _E, infer X>
  ? Exclude<AllInstructionIds, X>
  : never;

// Keep `InstructionId` re-export available without forcing a barrel hop.
export type { InstructionId };
