"""Typed loaders for proto/*.json source files."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Final


class SchemaError(ValueError):
    """Raised when a proto/*.json source file fails validation.

    Distinct from runtime ``QuantError`` so that codegen — a build tool —
    has no reverse dependency on the runtime it generates.
    """


PROTO_ROOT: Final[Path] = Path(__file__).resolve().parent.parent
ERRORS_JSON: Final[Path] = PROTO_ROOT / "errors.json"


@dataclass(frozen=True, slots=True)
class ErrorCodeSpec:
    """One row in ``proto/errors.json``."""

    name: str
    number: int
    http: int
    description: str


@dataclass(frozen=True, slots=True)
class ErrorsSchema:
    """Parsed view of ``proto/errors.json`` — the single source of truth."""

    schema_version: int
    codes: tuple[ErrorCodeSpec, ...]


def _parse_entry(entry: object) -> ErrorCodeSpec:
    """Validate one row from ``proto/errors.json``.

    Raises:
        SchemaError: if any field is missing or has the wrong type / shape.
    """
    if not isinstance(entry, dict):
        raise SchemaError(f"errors.json: entry must be object: {entry!r}")
    name = entry.get("name")
    number = entry.get("number")
    http = entry.get("http")
    description = entry.get("description", "")
    if not isinstance(name, str) or not name or not name.replace("_", "").isalnum():
        raise SchemaError(f"errors.json: bad name: {name!r}")
    if name != name.upper():
        raise SchemaError(f"errors.json: name not UPPER_SNAKE: {name!r}")
    if not isinstance(number, int) or isinstance(number, bool) or number < 0:
        raise SchemaError(f"errors.json: bad number for {name}: {number!r}")
    if not isinstance(http, int) or isinstance(http, bool) or not 100 <= http <= 599:
        raise SchemaError(f"errors.json: bad http for {name}: {http!r}")
    if not isinstance(description, str):
        raise SchemaError(f"errors.json: bad description for {name}: {description!r}")
    return ErrorCodeSpec(name=name, number=number, http=http, description=description)


def load_errors() -> ErrorsSchema:
    """Parse ``proto/errors.json`` into a typed, validated schema.

    Returns:
        Frozen ``ErrorsSchema`` with codes ordered by their numeric value.

    Raises:
        SchemaError: if the source file is malformed (duplicate names/numbers,
            missing required fields, names not UPPER_SNAKE_CASE).
    """
    raw = json.loads(ERRORS_JSON.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise SchemaError(f"{ERRORS_JSON.name} must be a JSON object")
    if raw.get("$schema_version") != 1:
        raise SchemaError(
            f"{ERRORS_JSON.name} unsupported $schema_version: {raw.get('$schema_version')!r}"
        )
    codes_raw = raw.get("codes")
    if not isinstance(codes_raw, list):
        raise SchemaError(f"{ERRORS_JSON.name} 'codes' must be a list")

    seen_names: set[str] = set()
    seen_numbers: set[int] = set()
    parsed: list[ErrorCodeSpec] = []
    for entry in codes_raw:
        spec = _parse_entry(entry)
        if spec.name in seen_names:
            raise SchemaError(f"errors.json: duplicate name: {spec.name}")
        if spec.number in seen_numbers:
            raise SchemaError(f"errors.json: duplicate number: {spec.number}")
        seen_names.add(spec.name)
        seen_numbers.add(spec.number)
        parsed.append(spec)

    parsed.sort(key=lambda c: c.number)
    return ErrorsSchema(schema_version=1, codes=tuple(parsed))
