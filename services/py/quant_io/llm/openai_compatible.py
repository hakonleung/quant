"""Generic OpenAI-compatible :class:`LLMClient` adapter.

DeepSeek, Moonshot, Doubao, OpenAI itself, and most domestic Chinese
LLM endpoints all expose the same chat-completions surface with
``response_format={"type":"json_object"}``. We drive every one of them
through this single adapter and inject the differences (``base_url``,
``model``, ``api_key``) at construction time from
:data:`quant_io.llm.providers.LLM_PROVIDERS`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from openai import OpenAI


_DEFAULT_TIMEOUT_SEC: Final[float] = 60.0


class OpenAiCompatibleLlmClient:
    """JSON-output chat client for any OpenAI-compatible endpoint."""

    __slots__ = ("_client", "_model", "_provider")

    def __init__(
        self,
        *,
        provider_name: str,
        base_url: str,
        model: str,
        api_key: str,
        timeout_sec: float = _DEFAULT_TIMEOUT_SEC,
        client: OpenAI | None = None,
    ) -> None:
        self._provider = provider_name
        self._model = model
        if client is not None:
            # Test override — caller wired a stub OpenAI-shaped client.
            self._client = client
            return
        from openai import OpenAI  # imported lazily so tests don't pay the cost

        self._client = OpenAI(
            api_key=api_key,
            base_url=base_url.rstrip("/"),
            timeout=timeout_sec,
        )

    @property
    def name(self) -> str:
        return self._provider

    @property
    def model(self) -> str:
        return self._model

    def complete_json(self, *, system: str, user: str) -> str:
        try:
            response = self._client.chat.completions.create(
                model=self._model,
                temperature=0,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
        except Exception as exc:
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: {type(exc).__name__}: {exc}",
                {"source": self._provider, "exc_type": type(exc).__name__},
            ) from exc
        choices = getattr(response, "choices", None)
        if not choices:
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: response has no choices",
                {"source": self._provider},
            )
        message = getattr(choices[0], "message", None)
        content = getattr(message, "content", None) if message is not None else None
        if not isinstance(content, str):
            raise QuantError(
                "LLM_FAILED",
                f"{self._provider}: response 'content' is not a string",
                {"source": self._provider},
            )
        return content
