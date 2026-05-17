# InstructionCenter Migration — Plan & State

Living doc. Tracks the rollout from parallel FE `CommandRegistry` + BE
`InstructionRegistry` to a unified `InstructionCenter<Env, Excluded>`
shared via `packages/shared/src/instructions/`.

## Done

- **Phase 1 — manifest as source of truth.** Every instruction has a
  typed `argsSchema` + `resultSchema`. Aliases / mode / IM gate /
  double-confirm / revalidate / positional binding are declared once.
- **Phase 2 — BE migration.** 27 of 31 ids on `BeInstructionCenter`.
  Legacy `InstructionRegistry` still hosts `help` (IM-only,
  LegacyOutput), `ping`, `channel.echo`, `channel.send`.
  - Recent additions: `ledger.add`, `ledger.remove`, `sector.add`,
    `sector.refresh` (migrated from legacy `SectorRefreshInstructionHandler`),
    `stock.info`, `stock.kline`. Each wraps an existing service —
    no new endpoints, just typed access through the manifest.
- **Phase 3 — FE cells.** Migrated to
  `apps/web/lib/instructions/cells/`: `usr`, `clear`, `cache`,
  `focus`, `update`, `help`, `ledger` + 3 subs, `stock` + 2 subs,
  `screen`, `analyze` + sector sub, `ta` + sector sub, `sector` + 6
  subs, `watch` + 3 subs. Only `agent` remains on the legacy
  `CommandRegistry`. Legacy command files for everything else have
  been removed from `packages/terminal/src/commands/`.
  - `screen` syntax change: dropped the redundant `nl` keyword
    (`screen <query>` is enough). Force-confirm flow uses the
    `confirm-required` envelope code — handler throws it, renderer
    surfaces the confirm widget.
  - `analyze` / `ta` follow the same `confirm-required` pattern for
    `fresh=1` paths.
  - `sector add` multi-step form is gone; callers pass
    `sector.add sector=<json>` directly.
  - `watch add` guided form (conditions / intervals) gone; users
    invoke `watch.add code=... market=... group=...` against the
    manifest's narrower schema.
  - `watch rm <market> <code>` replaced by `watch.remove id=wN`.
- **Phase 4 cleanup.** Dropped `supportedOn`,
  `conditionallyRegistered`, `assertHandlerCoverage`, and the
  `OnApplicationBootstrap` coverage check now that mapped-type config
  enforces per-side cell presence at compile time.

## Manifest ids now available for FE thin-proxy use

Every subcommand the legacy FE `runCommand` dispatches to has a typed
BE cell:

- `stock` (search), `stock.info`, `stock.kline`
- `ledger` (list), `ledger.add`, `ledger.remove`, `ledger.analyze`
- `sector` (list), `sector.show`, `sector.add`, `sector.publish`,
  `sector.unpublish`, `sector.refresh`, `sector.rm`
- `watch` (list), `watch.add`, `watch.remove`, `watch.group`
- `screen` (NL screen)
- `analyze`, `analyze.sector`
- `ta`, `ta.sector`
- `agent`, `agent.confirm`

## Still on the legacy `CommandRegistry`

Only `agent`. Its streaming subscription + event dispatcher doesn't
fit the request/response `InstructionCell` shape — it needs either
a `StreamingInstructionCell<E, I>` variant (handler returns void +
emits frames through a sink on `ctx`) or stays out of the center.
The FE shell falls through to legacy for `agent`; everything else
is intercepted by `feCenter` first.

## Remaining work

1. **Decide `agent`'s shape.** Options: introduce
   `StreamingInstructionCell<E, I>` in `packages/shared/src/instructions/center.ts`
   with a different return contract (handler emits frames via a sink
   on `ctx`), or keep `/agent` on the legacy registry indefinitely.
2. **Optional widening of `WatchAddArgsSchema`** if the
   conditions / intervals form needs to come back as a cell renderer.
   No correctness issue with the current narrower shape.
3. **Optional re-introduction of multi-step forms** (e.g. `sector.add`
   name → kind → codes flow) as cell renderers that emit follow-up
   command lines on submit. Same pattern as the existing
   `confirm-required` envelope flow, just with form data threaded
   through the line.

## Pattern for a new FE cell

The five existing FE cells (`usr.cell.ts` etc.) follow this shape:

```ts
export function buildFooCell(): InstructionCell<FeEnv, 'foo'> {
  return {
    async handler(args, ctx): Promise<ResultOf<'foo'>> {
      const env = await ctx.api.invoke('foo', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope, host) {
      if (!envelope.ok) return textErr(envelope.error.message);
      // Build widget / text from envelope.data + host primitives.
    },
  };
}
```

Register it in `apps/web/lib/instructions/fe-center.ts` by adding the
id to `FeMigratedIds` and the builder to the config object. The
mapped-type check forces both updates at compile time.

Drop the matching legacy `CommandSpec` from
`packages/terminal/src/commands/index.ts` so the FE shell stops
falling through to the old path.

## Pattern for a new BE cell + manifest id

1. Add `XxxArgsSchema` + `XxxResultSchema` in
   `packages/shared/src/instructions/schemas.ts`.
2. Add the manifest entry in
   `packages/shared/src/instructions/manifest.ts` referencing those
   schemas.
3. Build the BE cell in
   `apps/api/src/modules/instruction-center/cells/xxx.cell.ts` and
   register it in `BeInstructionCenter`. The `MigratedIds` mapped
   type forces the registration.
4. Add a renderer in the same directory if the IM surface needs
   richer than the BE cell's default text output.

## Why this is incremental, not a single PR

The unification finds real divergences between FE and BE payload
shapes (see `screen`, `analyze`). Each one needs a small,
reviewable conversation about which shape wins, not a sweeping
rewrite. Treat every command as its own contract negotiation.
