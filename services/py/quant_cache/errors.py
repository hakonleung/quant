"""Cache-layer exception hierarchy (cache-abstraction.md §7).

All adapter implementations in :mod:`quant_cache` convert backend-specific
failures (``OSError``, ``json.JSONDecodeError``, ``pyarrow.ArrowIOError``,
``psycopg.Error``, ...) into one of the subclasses below. Business code
catches at this level and never sees the underlying SDK exceptions.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.contracts.errors import ErrorCode


class CacheError(QuantError):
    """Base for any cache-layer failure."""

    DEFAULT_CODE: ClassVar[ErrorCode] = "INTERNAL"

    __slots__ = ()

    def __init__(
        self,
        message: str,
        details: Mapping[str, object] | None = None,
        *,
        code: ErrorCode | None = None,
    ) -> None:
        super().__init__(code if code is not None else self.DEFAULT_CODE, message, details)


class CacheKeyNotFound(CacheError):
    """Requested key/record absent from the cache."""

    DEFAULT_CODE: ClassVar[ErrorCode] = "CACHE_KEY_NOT_FOUND"

    __slots__ = ()


class CacheCorrupted(CacheError):
    """Stored bytes failed integrity / schema decode."""

    DEFAULT_CODE: ClassVar[ErrorCode] = "CACHE_CORRUPTED"

    __slots__ = ()


class CacheBackendUnavailable(CacheError):
    """Backend unreachable / locked / out of disk."""

    DEFAULT_CODE: ClassVar[ErrorCode] = "CACHE_BACKEND_UNAVAILABLE"

    __slots__ = ()
