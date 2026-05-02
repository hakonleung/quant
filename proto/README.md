# proto/ — Cross-process contracts (single source of truth)

All Python ↔ NestJS ↔ Web shared types, error codes, and Arrow schemas live here.
Both sides import generated code; **handwritten duplicates of these contracts will be rejected in review** (CLAUDE.md §2.5.2 + §8).

## Layout (current — M2 bootstrap)

```
proto/
├── errors.json           # ErrorCode source of truth
├── codegen/              # hand-written Python codegen (no protoc)
│   ├── __init__.py
│   ├── __main__.py       # entrypoint: `python -m proto.codegen [--check]`
│   ├── _emit.py          # shared helpers
│   ├── gen_py_errors.py  # → services/py/quant_core/contracts/errors.py
│   └── gen_ts_errors.py  # → packages/shared/src/contracts/errors.ts
└── README.md
```

Future milestones will add: `messages/*.json` (control plane), `schemas/arrow/*.json`
(data plane), and matching codegen for pydantic models + zod schemas + Arrow schemas.

## Why hand-written (not protoc / buf)

- v1 ships a tiny contract surface; pulling in `protoc` / `buf` toolchain is
  heavier than the problem requires.
- Both targets (pydantic + zod) need bespoke shape; off-the-shelf gens produce
  awkward output that we'd post-process anyway.
- When the surface grows past ~10 message types, we will revisit.

## Workflow

```bash
# regenerate after editing any source file in proto/
pnpm gen:proto

# CI / pnpm check verifies generated files are in sync with sources
pnpm gen:proto:check
```

`gen:proto:check` re-runs the generator in-memory and diffs against the
on-disk output; non-zero exit if drift exists.

## Conventions

- Error code names: `UPPER_SNAKE_CASE`, stable forever — never renumber, never
  reuse a numeric value (deprecate instead).
- All generated files start with the marker:
  ```
  // GENERATED FILE — DO NOT EDIT BY HAND
  // Source: proto/errors.json
  // Regenerate: pnpm gen:proto
  ```
- Generated files are committed (so consumers don't need to run codegen on
  install) and gated by `gen:proto:check`.
