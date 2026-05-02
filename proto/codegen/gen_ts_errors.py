"""Emit ``packages/shared/src/contracts/errors.ts`` from proto/errors.json."""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from ._emit import GENERATED_BANNER_TS, write_or_check
from ._schema import PROTO_ROOT, ErrorsSchema

if TYPE_CHECKING:
    from pathlib import Path

TS_TARGET: Final[Path] = (
    PROTO_ROOT.parent / "packages" / "shared" / "src" / "contracts" / "errors.ts"
)
TS_PACKAGE_INDEX: Final[Path] = TS_TARGET.parent / "index.ts"


def render(schema: ErrorsSchema) -> str:
    """Render the TS module body for the given error schema."""
    lines: list[str] = [GENERATED_BANNER_TS.format(src="errors.json")]
    lines.append("export const ERROR_CODES = [")
    for code in schema.codes:
        lines.append(f"  '{code.name}',")
    lines.append("] as const;")
    lines.append("")
    lines.append("export type ErrorCode = (typeof ERROR_CODES)[number];")
    lines.append("")
    lines.append("// Set<string> (not Set<ErrorCode>) so the type guard below has no `as` cast.")
    lines.append("const codeSet: ReadonlySet<string> = new Set<string>(ERROR_CODES);")
    lines.append("")
    lines.append(
        "export const ERROR_NUMBERS: Readonly<Record<ErrorCode, number>> = Object.freeze({"
    )
    for code in schema.codes:
        lines.append(f"  {code.name}: {code.number},")
    lines.append("});")
    lines.append("")
    lines.append(
        "export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({"
    )
    for code in schema.codes:
        lines.append(f"  {code.name}: {code.http},")
    lines.append("});")
    lines.append("")
    lines.append("export function isErrorCode(value: unknown): value is ErrorCode {")
    lines.append("  return typeof value === 'string' && codeSet.has(value);")
    lines.append("}")
    lines.append("")
    return "\n".join(lines)


def render_index() -> str:
    """Render the contracts barrel re-export."""
    return (
        GENERATED_BANNER_TS.format(src="errors.json")
        + "export {\n"
        + "  ERROR_CODES,\n"
        + "  ERROR_HTTP_STATUS,\n"
        + "  ERROR_NUMBERS,\n"
        + "  isErrorCode,\n"
        + "} from './errors.js';\n"
        + "export type { ErrorCode } from './errors.js';\n"
    )


def emit(schema: ErrorsSchema, *, check: bool) -> bool:
    """Write (or check) the TS error module + index re-export."""
    ok_module = write_or_check(TS_TARGET, render(schema), check=check)
    ok_index = write_or_check(TS_PACKAGE_INDEX, render_index(), check=check)
    return ok_module and ok_index
