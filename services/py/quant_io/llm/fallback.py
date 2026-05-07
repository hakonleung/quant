"""Fallback chain over a list of :class:`LLMClient` adapters.

When the user requests a specific provider via ``prefer_provider`` but
that provider's API key is missing or the call itself fails, we want to
keep going down a priority list rather than hard-fail. The ``ta``
service is the first caller — Kimi Pro is preferred for technical
analysis quality, but a 500 / 429 / "temporarily unavailable" should
silently fall through to qwen / deepseek so the user still gets an
answer.

Only ``complete_json`` is fallback-aware. ``complete_with_web_search``
is not used by callers that opt into the chain (TA does not need search)
and falling back across providers mid-search-loop is meaningless —
implementing it would only invite confusion.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Sequence

    from quant_io.llm.openai_compatible import OpenAiCompatibleLlmClient


logger = logging.getLogger(__name__)


class FallbackLlmClient:
    """LLMClient implementation that tries each adapter in order.

    The first ``complete_json`` to return a string wins. ``QuantError``
    with ``code="LLM_FAILED"`` is the only signal we treat as recoverable;
    every other exception (programmer error, ``INVALID_ARGUMENT``, etc.)
    propagates immediately because retrying on a different provider would
    not change the outcome.
    """

    __slots__ = ("_clients",)

    def __init__(self, clients: Sequence[OpenAiCompatibleLlmClient]) -> None:
        if not clients:
            raise QuantError(
                "LLM_FAILED",
                "FallbackLlmClient requires at least one client",
            )
        self._clients = tuple(clients)

    @property
    def name(self) -> str:
        # Composite name surfaces the chain order in logs / state.
        return "+".join(c.name for c in self._clients)

    @property
    def clients(self) -> tuple[OpenAiCompatibleLlmClient, ...]:
        """Read-only view of the underlying chain (for tests / debug)."""
        return self._clients

    def complete_json(self, *, system: str, user: str) -> str:
        attempts: list[dict[str, object]] = []
        for idx, client in enumerate(self._clients):
            try:
                return client.complete_json(system=system, user=user)
            except QuantError as exc:
                if exc.code != "LLM_FAILED":
                    raise
                attempts.append(
                    {
                        "provider": client.name,
                        "model": client.model,
                        "code": exc.code,
                        "error": str(exc),
                    }
                )
                is_last = idx == len(self._clients) - 1
                if is_last:
                    break
                logger.warning(
                    "ta_llm_fallback",
                    extra={
                        "provider": client.name,
                        "model": client.model,
                        "next_provider": self._clients[idx + 1].name,
                        "error": str(exc),
                    },
                )
        raise QuantError(
            "LLM_FAILED",
            "every provider in the fallback chain failed: "
            + ", ".join(f"{a['provider']}({a['error']})" for a in attempts),
            {"attempts": tuple(attempts)},
        )

    def complete_with_web_search(
        self,
        *,
        system: str,
        user: str,
        max_searches: int,
    ) -> str:
        # Web-search is not chain-aware on purpose: retrying a multi-turn
        # tool loop on a different provider would re-do every search and
        # at best reach the same answer. Callers that need web search
        # should construct the client directly via build_llm_client.
        return self._clients[0].complete_with_web_search(
            system=system, user=user, max_searches=max_searches
        )
