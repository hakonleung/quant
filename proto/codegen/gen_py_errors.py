"""Emit ``services/py/quant_core/contracts/errors.py`` from proto/errors.json."""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from ._emit import GENERATED_BANNER_PY, write_or_check
from ._schema import PROTO_ROOT, ErrorsSchema

if TYPE_CHECKING:
    from pathlib import Path

PY_TARGET: Final[Path] = (
    PROTO_ROOT.parent / "services" / "py" / "quant_core" / "contracts" / "errors.py"
)
PY_PACKAGE_INIT: Final[Path] = PY_TARGET.parent / "__init__.py"


def render(schema: ErrorsSchema) -> str:
    """Render the Python module body for the given error schema."""
    lines: list[str] = [
        GENERATED_BANNER_PY.format(src="errors.json"),
        "from __future__ import annotations",
        "",
        "from types import MappingProxyType",
        "from typing import Final, Literal",
        "",
        "ErrorCode = Literal[",
    ]
    for code in schema.codes:
        lines.append(f'    "{code.name}",')
    lines.append("]")
    lines.append('"""Closed set of cross-process error codes (proto/errors.json)."""')
    lines.append("")
    lines.append("ERROR_CODES: Final[frozenset[ErrorCode]] = frozenset(")
    lines.append("    (")
    for code in schema.codes:
        lines.append(f'        "{code.name}",')
    lines.append("    )")
    lines.append(")")
    lines.append("")
    lines.append("ERROR_NUMBERS: Final[MappingProxyType[ErrorCode, int]] = MappingProxyType({")
    for code in schema.codes:
        lines.append(f'    "{code.name}": {code.number},')
    lines.append("})")
    lines.append("")
    lines.append("ERROR_HTTP_STATUS: Final[MappingProxyType[ErrorCode, int]] = MappingProxyType({")
    for code in schema.codes:
        lines.append(f'    "{code.name}": {code.http},')
    lines.append("})")
    lines.append("")
    return "\n".join(lines)


def render_init() -> str:
    """Render the ``contracts`` package ``__init__`` re-exporting errors."""
    return (
        GENERATED_BANNER_PY.format(src="errors.json")
        + "from .errors import (\n"
        + "    ERROR_CODES,\n"
        + "    ERROR_HTTP_STATUS,\n"
        + "    ERROR_NUMBERS,\n"
        + "    ErrorCode,\n"
        + ")\n"
        + "\n"
        + "__all__ = [\n"
        + '    "ERROR_CODES",\n'
        + '    "ERROR_HTTP_STATUS",\n'
        + '    "ERROR_NUMBERS",\n'
        + '    "ErrorCode",\n'
        + "]\n"
    )


def emit(schema: ErrorsSchema, *, check: bool) -> bool:
    """Write (or check) the Python error module + package init."""
    ok_module = write_or_check(PY_TARGET, render(schema), check=check)
    ok_init = write_or_check(PY_PACKAGE_INIT, render_init(), check=check)
    return ok_module and ok_init
