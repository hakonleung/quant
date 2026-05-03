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
    """LLM client that can drive a multi-round ``$web_search`` tool loop.

    Concrete implementation: Kimi (Moonshot) ``builtin_function`` named
    ``$web_search``. The adapter is responsible for:

    * passing the builtin-function tool descriptor to the model,
    * echoing every ``tool_calls`` chunk back in until the model returns
      ``finish_reason="stop"``,
    * counting the search invocations against ``max_searches`` and
      stopping early if exceeded (the model is then asked to finalise
      based on what it already retrieved),
    * returning the final assistant reply as raw JSON text.

    The port is deliberately kept narrow so business code does not bind to
    the OpenAI tool-call schema; adapters can swap in another vendor with
    the same surface."""

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
        """Run the tool loop and return the final JSON-shaped reply.

        Args:
            system: System prompt.
            user: User prompt.
            max_searches: Hard upper bound on ``$web_search`` invocations
                for this single call. Once exceeded, the adapter asks the
                model to wrap up rather than letting it search forever.

        Returns:
            The raw assistant content. Caller parses + validates.

        Raises:
            QuantError: ``LLM_FAILED`` for transport / quota / schema /
                missing-tool-support problems.
        """
        ...
