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
