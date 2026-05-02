"""Multi-source fallback chain (data-sources.md §3-§4).

Generic over a source protocol so the same logic powers stock-meta,
KLine, news. Two responsibilities:

1. **Order**: try sources by ``priority`` (low → high).
2. **Retry**: each attempt may retry transient errors per ``RetryPolicy``;
   non-transient errors fall through to the next source immediately.

When every source is exhausted, raises :class:`SourceChainExhausted`
with the per-source failure detail so operators can diagnose.
"""

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Generic, Protocol, TypeVar

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from quant_core.domain.types.source import SourceHealth

logger = logging.getLogger(__name__)


class _NamedSource(Protocol):
    @property
    def name(self) -> str: ...
    @property
    def priority(self) -> int: ...
    def healthcheck(self) -> SourceHealth: ...


T = TypeVar("T", bound=_NamedSource)
R = TypeVar("R")


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Exponential-backoff-with-jitter retry knobs."""

    max_attempts: int = 3
    backoff_base_ms: int = 200
    backoff_factor: float = 2.0
    backoff_jitter_ratio: float = 0.2
    retryable_codes: frozenset[str] = field(
        default_factory=lambda: frozenset({"SOURCE_UNAVAILABLE", "RATE_LIMITED"})
    )

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        if self.backoff_base_ms < 0:
            raise ValueError("backoff_base_ms must be >= 0")
        if self.backoff_factor < 1.0:
            raise ValueError("backoff_factor must be >= 1.0")
        if not 0.0 <= self.backoff_jitter_ratio <= 1.0:
            raise ValueError("backoff_jitter_ratio must be in [0, 1]")


@dataclass(frozen=True, slots=True)
class SourceAttempt:
    """One source's outcome — used for diagnostics in
    :class:`SourceChainExhausted`."""

    source: str
    code: str
    message: str


class SourceChainExhausted(QuantError):
    """Every source in the chain failed.

    Carries the per-source attempt list under ``details["attempts"]`` so
    operators can see the failure mode for each one in a single log line.
    """

    def __init__(self, attempts: Sequence[SourceAttempt]) -> None:
        super().__init__(
            "SOURCE_UNAVAILABLE",
            f"all sources exhausted ({len(attempts)} attempts)",
            {
                "attempts": [
                    {"source": a.source, "code": a.code, "message": a.message} for a in attempts
                ]
            },
        )


class SourceChain(Generic[T]):
    """Ordered list of sources with retry + fallback semantics."""

    __slots__ = ("_retry", "_sleep", "_sources")

    def __init__(
        self,
        sources: Sequence[T],
        retry: RetryPolicy | None = None,
        *,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not sources:
            raise ValueError("SourceChain requires at least one source")
        self._sources: tuple[T, ...] = tuple(sorted(sources, key=lambda s: s.priority))
        self._retry = retry or RetryPolicy()
        self._sleep = sleep

    @property
    def sources(self) -> tuple[T, ...]:
        """Sources in priority order."""
        return self._sources

    def healthcheck_all(self) -> list[SourceHealth]:
        """Probe every source, in priority order. Never raises."""
        return [s.healthcheck() for s in self._sources]

    def call(self, fn: Callable[[T], R]) -> R:
        """Invoke ``fn`` against each source in turn until one succeeds.

        Per-source: if the call raises ``QuantError`` with a retryable
        code, retry per :attr:`RetryPolicy`; on a non-retryable code,
        skip immediately to the next source. Non-``QuantError`` exceptions
        propagate as programmer bugs.
        """
        attempts: list[SourceAttempt] = []
        for source in self._sources:
            value, last_err = self._try_source(source, fn)
            if last_err is None:
                # Type narrowed by the precondition: success ⇒ value is R
                assert value is not _UNSET
                return value  # type: ignore[return-value]
            attempts.append(SourceAttempt(source.name, last_err.code, str(last_err)))
        raise SourceChainExhausted(attempts)

    def _try_source(
        self,
        source: T,
        fn: Callable[[T], R],
    ) -> tuple[R | object, QuantError | None]:
        """Run ``fn(source)`` with retries; return (result, None) on
        success, (sentinel, last_error) on exhaustion."""
        last_err: QuantError | None = None
        for attempt in range(1, self._retry.max_attempts + 1):
            try:
                return fn(source), None
            except QuantError as err:
                last_err = err
                # `message` is a reserved key in `LogRecord.__dict__`; use
                # `error_message` to carry the human description in the
                # structured field.
                logger.warning(
                    "source_attempt_failed",
                    extra={
                        "source": source.name,
                        "attempt": attempt,
                        "code": err.code,
                        "error_message": str(err),
                    },
                )
                if err.code not in self._retry.retryable_codes:
                    break
                if attempt < self._retry.max_attempts:
                    self._sleep(self._sleep_seconds(attempt))
        return _UNSET, last_err

    def _sleep_seconds(self, attempt: int) -> float:
        base = self._retry.backoff_base_ms * (self._retry.backoff_factor ** (attempt - 1))
        jitter = base * self._retry.backoff_jitter_ratio
        # SystemRandom not needed — jitter is for backoff, not security.
        return max(0.0, (base + random.uniform(-jitter, jitter)) / 1000.0)


_UNSET: object = object()
