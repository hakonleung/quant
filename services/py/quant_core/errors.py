"""Domain error base class. Mirrors TS `QuantError` in packages/shared/errors.

Error ``code`` values are the closed ``ErrorCode`` literal defined in
``quant_core.contracts.errors`` (generated from ``proto/errors.json``).
Both languages import the same generated enum so codes cannot drift.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.contracts.errors import ErrorCode


class QuantError(Exception):
    """Base class for all domain errors that cross process boundaries.

    Args:
        code: One of the stable codes from ``proto/errors.json``.
        message: Human-readable description.
        details: Structured context. Stored as an immutable mapping.
    """

    __slots__ = ("code", "details")

    code: Final[ErrorCode]
    details: Mapping[str, object]

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        details: Mapping[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = MappingProxyType(dict(details) if details else {})
