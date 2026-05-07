"""Unit tests for :class:`FallbackLlmClient`.

Covers chain success on first/middle/last client, full-chain failure,
and the rule that non-LLM_FAILED errors propagate without retry.
"""

from __future__ import annotations

from typing import Any

import pytest
from quant_core.errors import QuantError
from quant_io.llm.fallback import FallbackLlmClient


class _StubClient:
    """Minimal stand-in for :class:`OpenAiCompatibleLlmClient`."""

    def __init__(
        self,
        name: str,
        *,
        json_response: str | None = None,
        json_error: BaseException | None = None,
    ) -> None:
        self._name = name
        self._json_response = json_response
        self._json_error = json_error
        self.calls: list[dict[str, Any]] = []

    @property
    def name(self) -> str:
        return self._name

    @property
    def model(self) -> str:
        return f"{self._name}-pro"

    def complete_json(self, *, system: str, user: str) -> str:
        self.calls.append({"system": system, "user": user})
        if self._json_error is not None:
            raise self._json_error
        assert self._json_response is not None
        return self._json_response

    def complete_with_web_search(
        self, *, system: str, user: str, max_searches: int
    ) -> str:
        return f"{self._name}:{system}:{user}:{max_searches}"


def test_first_client_wins() -> None:
    a = _StubClient("a", json_response="A")
    b = _StubClient("b", json_response="B")
    chain = FallbackLlmClient([a, b])  # type: ignore[arg-type]
    assert chain.complete_json(system="s", user="u") == "A"
    assert len(a.calls) == 1
    assert len(b.calls) == 0


def test_falls_back_to_next_on_llm_failed() -> None:
    a = _StubClient("a", json_error=QuantError("LLM_FAILED", "down"))
    b = _StubClient("b", json_response="B")
    chain = FallbackLlmClient([a, b])  # type: ignore[arg-type]
    assert chain.complete_json(system="s", user="u") == "B"
    assert len(a.calls) == 1
    assert len(b.calls) == 1


def test_falls_through_to_third_client() -> None:
    a = _StubClient("a", json_error=QuantError("LLM_FAILED", "down1"))
    b = _StubClient("b", json_error=QuantError("LLM_FAILED", "down2"))
    c = _StubClient("c", json_response="C")
    chain = FallbackLlmClient([a, b, c])  # type: ignore[arg-type]
    assert chain.complete_json(system="s", user="u") == "C"


def test_all_failures_raise_with_attempts_log() -> None:
    a = _StubClient("a", json_error=QuantError("LLM_FAILED", "boom-a"))
    b = _StubClient("b", json_error=QuantError("LLM_FAILED", "boom-b"))
    chain = FallbackLlmClient([a, b])  # type: ignore[arg-type]
    with pytest.raises(QuantError) as excinfo:
        chain.complete_json(system="s", user="u")
    assert excinfo.value.code == "LLM_FAILED"
    attempts = excinfo.value.details.get("attempts")
    assert isinstance(attempts, tuple)
    assert {entry["provider"] for entry in attempts} == {"a", "b"}


def test_non_llm_failed_propagates_immediately() -> None:
    a = _StubClient("a", json_error=QuantError("INVALID_ARGUMENT", "bad input"))
    b = _StubClient("b", json_response="B")
    chain = FallbackLlmClient([a, b])  # type: ignore[arg-type]
    with pytest.raises(QuantError) as excinfo:
        chain.complete_json(system="s", user="u")
    assert excinfo.value.code == "INVALID_ARGUMENT"
    # b must NOT have been called — a non-recoverable error short-circuits.
    assert len(b.calls) == 0


def test_empty_chain_rejected() -> None:
    with pytest.raises(QuantError):
        FallbackLlmClient([])


def test_composite_name() -> None:
    a = _StubClient("a", json_response="ignored")
    b = _StubClient("b", json_response="ignored")
    chain = FallbackLlmClient([a, b])  # type: ignore[arg-type]
    assert chain.name == "a+b"
