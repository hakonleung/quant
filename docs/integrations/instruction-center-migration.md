# InstructionCenter Migration — Plan & State

Living doc. Tracks the rollout from parallel FE `CommandRegistry` + BE
`InstructionRegistry` to a unified `InstructionCenter<Env, Excluded>`
shared via `packages/shared/src/instructions/`.

## Done

- **Phase 1 — manifest as source of truth.** Every instruction has a
  typed `argsSchema` + `resultSchema`. Aliases / mode / IM gate /
  double-confirm / revalidate / positional binding are declared once.
- **Phase 2 — BE migration.** 21 of 25 ids are configured on
  `BeInstructionCenter`. The legacy `InstructionRegistry` still hosts
  `help` (IM-only, returns LegacyOutput), `ping`, `channel.echo`,
  `channel.send`.
- **Phase 3 partial — FE cells for cell-shaped commands.** `usr`,
  `clear`, `cache`, `focus`, `update`, `help` migrated to
  `apps/web/lib/instructions/cells/`. Each is a thin handler + a
  side-specific renderer.
- **Phase 4 cleanup.** Dropped `supportedOn`,
  `conditionallyRegistered`, `assertHandlerCoverage`, and the
  `OnApplicationBootstrap` coverage check now that mapped-type config
  enforces per-side cell presence at compile time.

## Still on the legacy `CommandRegistry`

`stock`, `ledger`, `analyze`, `ta`, `screen`, `watch`, `sector`,
`agent`. These work today through `runCommand(line, ctx, registry)`;
the FE shell falls through to that path when `feCenterCanDispatch`
returns false.

## Why they aren't migrated yet

Each command has a structural blocker that makes a "thin proxy"
migration fail in a different way:

| Command | Blocker |
|---------|---------|
| `analyze`, `ta` | Renderer reads `Sentiment` fields (`topTheme`, `topDriver`, `cachedAt`) that the in-progress `SentimentSchema` refactor is removing. Migrating now commits code against a moving target. |
| `screen` | Legacy FE uses `screenNlAction` REST → `{ matches, dslSummary }`. Manifest `screen` cell returns `{ nl, asof, codes, stockRows }`. Different payload, different widget. Migration = UI rewrite, not relocation. |
| `ledger` | 4 subcommands; `ledger.add` / `ledger.remove` aren't manifest ids. `rm` is a two-stage confirm flow. |
| `watch` | 4 subcommands; `add` is an interactive form (not a one-shot invoke). |
| `sector` | 7 subcommands; `add` is a multi-step interactive form. `sector.add` and `sector.refresh` aren't manifest ids. |
| `stock` | 3 modes (picker / info / kline). `stock.info` / `stock.kline` aren't manifest ids; picker is pure-FE state and needs `host.stockIndex` access. |
| `agent` | Streaming subscription + event dispatcher. The current `InstructionCell` shape is request/response — agent needs either a separate streaming variant or stays out of the center. |

## Recommended order to finish

1. **Wait for the `SentimentSchema` refactor to land**, then migrate
   `analyze` / `ta` against the settled shape.
2. **Add the 6 missing BE manifest entries + cells:**
   `stock.info`, `stock.kline`, `ledger.add`, `ledger.remove`,
   `sector.add`, `sector.refresh`. Each is a small standalone commit
   that touches `schemas.ts`, `manifest.ts`, and one new BE cell file.
3. **FE cells become thin proxies** for those ids once the BE side
   exists. The cell renderer still hosts the widget (picker / confirm
   / pager) — only the data fetch goes through `ctx.api.invoke`.
4. **Decide `agent`'s shape separately.** Options: introduce
   `StreamingInstructionCell<E, I>` with a different return contract,
   or keep `/agent` on the legacy registry indefinitely (it's the
   only command with a long-lived BE subscription).

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
