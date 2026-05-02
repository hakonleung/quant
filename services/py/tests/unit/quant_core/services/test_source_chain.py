"""Unit tests for :class:`SourceChain` + :class:`RetryPolicy`."""

from __future__ import annotations

import pytest
from quant_core.domain.types.source import SourceHealth
from quant_core.errors import QuantError
from quant_core.services.source_chain import (
    RetryPolicy,
    SourceChain,
    SourceChainExhausted,
)


class _FakeSource:
    """Scriptable source: each `fetch()` returns the next value or raises."""

    def __init__(self, name: str, priority: int, script: list[object]) -> None:
        self._name = name
        self._priority = priority
        self._script = list(script)
        self.calls = 0

    @property
    def name(self) -> str:
        return self._name

    @property
    def priority(self) -> int:
        return self._priority

    def healthcheck(self) -> SourceHealth:
        return SourceHealth(
            self._name, available=True, latency_ms=1, quota_remaining=None, last_error=None
        )

    def fetch(self) -> str:
        self.calls += 1
        action = self._script.pop(0)
        if isinstance(action, BaseException):
            raise action
        return str(action)


def _no_sleep(_seconds: float) -> None:
    return None


@pytest.mark.unit
class TestSourceChainHappyPath:
    def test_first_source_wins(self) -> None:
        a = _FakeSource("a", priority=1, script=["A"])
        b = _FakeSource("b", priority=2, script=["B"])
        chain = SourceChain([b, a], retry=RetryPolicy(max_attempts=1), sleep=_no_sleep)
        assert chain.call(lambda s: s.fetch()) == "A"
        assert b.calls == 0

    def test_orders_by_priority_not_input_order(self) -> None:
        low = _FakeSource("low", priority=1, script=["LOW"])
        high = _FakeSource("high", priority=10, script=["HIGH"])
        chain = SourceChain([high, low], sleep=_no_sleep)
        assert chain.sources[0].name == "low"
        assert chain.sources[1].name == "high"


@pytest.mark.unit
class TestSourceChainRetry:
    def test_retries_retryable_code_then_succeeds(self) -> None:
        a = _FakeSource(
            "a",
            priority=1,
            script=[QuantError("RATE_LIMITED", "slow down"), "A"],
        )
        chain = SourceChain([a], retry=RetryPolicy(max_attempts=3), sleep=_no_sleep)
        assert chain.call(lambda s: s.fetch()) == "A"
        assert a.calls == 2

    def test_does_not_retry_non_retryable_code(self) -> None:
        a = _FakeSource(
            "a",
            priority=1,
            script=[QuantError("INVALID_ARGUMENT", "bad"), "should not reach"],
        )
        b = _FakeSource("b", priority=2, script=["B"])
        chain = SourceChain([a, b], retry=RetryPolicy(max_attempts=3), sleep=_no_sleep)
        assert chain.call(lambda s: s.fetch()) == "B"
        # `a` was tried once and immediately bailed out
        assert a.calls == 1

    def test_falls_back_after_retries_exhaust(self) -> None:
        a = _FakeSource(
            "a",
            priority=1,
            script=[QuantError("RATE_LIMITED", "x")] * 3,
        )
        b = _FakeSource("b", priority=2, script=["B"])
        chain = SourceChain([a, b], retry=RetryPolicy(max_attempts=3), sleep=_no_sleep)
        assert chain.call(lambda s: s.fetch()) == "B"
        assert a.calls == 3

    def test_exhausted_chain_raises_with_all_attempts(self) -> None:
        a = _FakeSource("a", priority=1, script=[QuantError("RATE_LIMITED", "a-fail")] * 3)
        b = _FakeSource("b", priority=2, script=[QuantError("SOURCE_UNAVAILABLE", "b-fail")] * 3)
        chain = SourceChain([a, b], retry=RetryPolicy(max_attempts=3), sleep=_no_sleep)
        with pytest.raises(SourceChainExhausted) as excinfo:
            chain.call(lambda s: s.fetch())
        attempts = excinfo.value.details["attempts"]
        assert isinstance(attempts, list)
        assert {a["source"] for a in attempts} == {"a", "b"}
        assert excinfo.value.code == "SOURCE_UNAVAILABLE"

    def test_non_quant_error_is_not_retried_and_propagates(self) -> None:
        a = _FakeSource("a", priority=1, script=[ValueError("oops")])
        chain = SourceChain([a], retry=RetryPolicy(max_attempts=3), sleep=_no_sleep)
        with pytest.raises(ValueError, match="oops"):
            chain.call(lambda s: s.fetch())
        assert a.calls == 1


@pytest.mark.unit
class TestSourceChainHealthcheck:
    def test_returns_one_entry_per_source_in_priority_order(self) -> None:
        chain = SourceChain(
            [_FakeSource("b", 2, []), _FakeSource("a", 1, [])],
            sleep=_no_sleep,
        )
        names = [h.name for h in chain.healthcheck_all()]
        assert names == ["a", "b"]


@pytest.mark.unit
class TestRetryPolicyValidation:
    @pytest.mark.parametrize(
        "kwargs",
        [
            {"max_attempts": 0},
            {"backoff_base_ms": -1},
            {"backoff_factor": 0.5},
            {"backoff_jitter_ratio": 1.5},
            {"backoff_jitter_ratio": -0.1},
        ],
    )
    def test_invalid_kwargs_raise(self, kwargs: dict[str, object]) -> None:
        with pytest.raises(ValueError, match=r".+"):
            RetryPolicy(**kwargs)  # type: ignore[arg-type]

    def test_default_retryable_codes(self) -> None:
        p = RetryPolicy()
        assert "RATE_LIMITED" in p.retryable_codes
        assert "SOURCE_UNAVAILABLE" in p.retryable_codes


@pytest.mark.unit
class TestSourceChainConstructor:
    def test_empty_sources_rejected(self) -> None:
        with pytest.raises(ValueError, match="at least one source"):
            SourceChain([])
