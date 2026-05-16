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
- **Phase 3 partial — FE cells.** `usr`, `clear`, `cache`, `focus`,
  `update`, `help` migrated to `apps/web/lib/instructions/cells/`.
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

`stock`, `ledger`, `analyze`, `ta`, `screen`, `watch`, `sector`,
`agent`. These work today through `runCommand(line, ctx, registry)`;
the FE shell falls through to that path when `feCenterCanDispatch`
returns false.

## Remaining FE-side blockers

The BE manifest now covers every legacy subcommand. The FE side
still defers for these reasons:

| Command | Blocker |
|---------|---------|
| `analyze`, `ta` | Renderer reads `Sentiment` fields (`topTheme`, `topDriver`, `cachedAt`) that the in-progress `SentimentSchema` refactor is removing. Migrating now commits code against a moving target. |
| `screen` | Legacy renderer expects `{ matches, dslSummary }`; manifest result is `{ nl, asof, codes, stockRows }`. Cell renderer needs to be rewritten against the new payload shape. |
| `ledger` | Multi-stage `rm` confirm + four subcommand ids; cell renderer needs to host the confirm widget for `ledger.remove`. |
| `watch` | `watch.add` is a multi-field interactive form, not a one-shot invoke. |
| `sector` | `sector.add` is a multi-step form (name → kind → codes). Cell handler is one-shot; the form lives in the FE renderer. |
| `stock` | Picker is pure-FE state, not a BE invoke; cell renderer needs to drive the picker via `host.stockIndex`. |
| `agent` | Streaming subscription + event dispatcher. The `InstructionCell` shape is request/response — agent needs either a `StreamingInstructionCell<E, I>` variant or stays out of the center. |

## Recommended order to finish

BE foundation is in place; remaining work is FE.

1. **Wait for the `SentimentSchema` refactor to land**, then migrate
   `analyze` / `ta` cells against the settled shape.
2. **Rewrite the legacy widget code as cell renderers** for `screen`,
   `ledger`, `stock`, `watch`, `sector`. Pattern per command:
   - One cell per manifest id (`ledger`, `ledger.add`, `ledger.remove`,
     `ledger.analyze` = 4 cells for the legacy `ledger` command).
   - Cell handler is one `ctx.api.invoke(id, args)` call.
   - Cell renderer hosts the widget (confirm / picker / pager / form).
   - The FE shell's dotted-subcommand dispatch routes
     `ledger add 2026-01-01 100` to the `ledger.add` cell automatically.
3. **Decide `agent`'s shape separately.** Options: introduce
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
