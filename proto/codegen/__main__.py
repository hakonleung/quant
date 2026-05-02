"""CLI entrypoint for cross-process contract codegen.

Usage:
    python -m proto.codegen           # write generated files
    python -m proto.codegen --check   # exit 1 if any output is stale
"""

from __future__ import annotations

import argparse
import sys

from . import gen_py_errors, gen_ts_errors
from ._schema import SchemaError, load_errors


def main(argv: list[str] | None = None) -> int:
    """Run all generators; return process exit code."""
    parser = argparse.ArgumentParser(
        prog="proto.codegen",
        description="Regenerate cross-process contract files from proto/*.json sources.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Do not write files; exit 1 if any output is out of date.",
    )
    args = parser.parse_args(argv)

    try:
        errors_schema = load_errors()
    except SchemaError as exc:
        print(f"[gen] schema invalid: {exc}", file=sys.stderr)
        return 1

    ok = True
    ok &= gen_py_errors.emit(errors_schema, check=args.check)
    ok &= gen_ts_errors.emit(errors_schema, check=args.check)

    if not ok:
        if args.check:
            print(
                "[gen:check] generated files are out of date — run `pnpm gen:proto` and commit.",
                file=sys.stderr,
            )
        return 1
    if not args.check:
        print(f"[gen] wrote {len(errors_schema.codes)} error codes")
    return 0


if __name__ == "__main__":  # pragma: no cover - thin CLI wrapper
    raise SystemExit(main())
