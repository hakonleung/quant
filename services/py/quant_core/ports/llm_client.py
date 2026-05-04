"""LLM port — minimal "give me a JSON response to this prompt" surface.

Adapter implementations live under ``quant_io.llm`` (DeepSeek, OpenAI-
compatible, etc.). Keeping the port narrow lets the nl-to-dsl service
stay backend-agnostic; the adapter handles auth, retries, transport.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class LLMClient(Protocol):
    """Send a single chat request and get JSON-shaped text back."""

    @property
    def name(self) -> str:
        """Stable identifier (e.g. ``"deepseek"``). Used in logs + state."""
        ...

    def complete_json(self, *, system: str, user: str) -> str:
        """Return the assistant's reply as a raw string.

        The caller is responsible for JSON-parsing + AST validation —
        the LLM does not always honour ``response_format=json_object``
        and the service layer needs to handle "text wrapping JSON" too.

        Raises:
            QuantError: ``LLM_FAILED`` on transport / auth / quota
                problems. The adapter must classify and not leak SDK
                exceptions.
        """
        ...


@runtime_checkable
class WebSearchLLMClient(Protocol):
    """LLM client that runs an analyst-style research turn against a
    web-search-enabled backend and returns the reply as plain text.

    Two transports are supported behind the port:

    * Moonshot (Kimi) ``$web_search`` ``builtin_function`` tool loop —
      the adapter echoes every ``tool_calls`` chunk back as
      ``role="tool"`` until ``finish_reason="stop"``, capping invocations
      at ``max_searches``.
    * DashScope (Qwen) — single chat call with
      ``extra_body={"enable_search": True}``; ``max_searches`` is ignored
      because the platform does not expose a per-call budget.

    Both return *plain analyst text*, not JSON. Callers are expected to
    feed the reply through a downstream summariser (e.g. a flash-tier
    JSON-output model) when structured fields are required."""

    @property
    def name(self) -> str:
        ...

    def complete_with_web_search(
        self,
        *,
        system: str,
        user: str,
        max_searches: int,
    ) -> str:
        """Run one research turn and return the assistant's plain-text reply.

        Args:
            system: System prompt (analyst persona).
            user: User prompt (research brief).
            max_searches: Upper bound on backend search invocations.
                Honoured by the Moonshot tool-loop transport; ignored on
                DashScope where the platform manages its own budget.

        Returns:
            The model's plain-text reply.

        Raises:
            QuantError: ``LLM_FAILED`` for transport / quota / schema /
                missing-tool-support problems.
        """
        ...
