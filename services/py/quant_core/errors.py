"""Domain error base class. Mirrors TS `QuantError` in packages/shared/errors.

Error `code` strings MUST match across languages — the canonical list lives in
proto/errors.proto (introduced in M2). Until then, callers pass code strings
manually and a contract test (M2) will assert cross-language parity.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import Mapping


class QuantError(Exception):
    """Base class for all domain errors that cross process boundaries.

    Args:
        code: Stable machine-readable identifier (UPPER_SNAKE_CASE).
        message: Human-readable description.
        details: Structured context. Stored as an immutable mapping.
    """

    __slots__ = ("code", "details")

    code: Final[str]
    details: Mapping[str, object]

    def __init__(
        self,
        code: str,
        message: str,
        details: Mapping[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = MappingProxyType(dict(details) if details else {})
