"""DeepSeek-backed :class:`LLMClient` (via the OpenAI Python SDK).

DeepSeek's chat-completions endpoint is OpenAI-compatible, so we drive
it through ``openai.OpenAI`` rather than hand-rolling HTTP. The SDK
handles retries, timeout plumbing, and JSON-mode framing for us.

Defaults:

* base url: ``https://api.deepseek.com``
* model:    ``deepseek-chat``  (override via the constructor or env)
* temperature: 0  (DSL translation must be deterministic)
* response_format: ``{"type": "json_object"}``

The constructor raises ``QuantError("LLM_FAILED")`` if neither the
``api_key`` arg nor the ``DEEPSEEK_API_KEY`` env var is set, so misuse
is caught at composition time, not at the first request.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Final

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from openai import OpenAI


_DEFAULT_BASE_URL: Final[str] = "https://api.deepseek.com"
_DEFAULT_MODEL: Final[str] = "deepseek-chat"
_DEFAULT_TIMEOUT_SEC: Final[float] = 60.0
_NAME: Final[str] = "deepseek"


class DeepSeekClient:
    """Minimal :class:`LLMClient` adapter over the OpenAI Python SDK."""

    __slots__ = ("_client", "_model")

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
        timeout_sec: float = _DEFAULT_TIMEOUT_SEC,
        client: OpenAI | None = None,
    ) -> None:
        key = api_key or os.environ.get("DEEPSEEK_API_KEY")
        if not key:
            raise QuantError(
                "LLM_FAILED",
                "DeepSeek API key missing (set DEEPSEEK_API_KEY or pass api_key=)",
                {"source": _NAME},
            )
        self._model = model or os.environ.get("DEEPSEEK_MODEL") or _DEFAULT_MODEL
        if client is not None:
            # Test override — caller has wired a stub OpenAI-shaped client.
            self._client = client
        else:
            from openai import OpenAI  # imported lazily so tests don't pay the cost

            resolved_base = (
                base_url or os.environ.get("DEEPSEEK_BASE_URL") or _DEFAULT_BASE_URL
            ).rstrip("/")
            self._client = OpenAI(api_key=key, base_url=resolved_base, timeout=timeout_sec)

    @property
    def name(self) -> str:
        return _NAME

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
                f"{_NAME}: {type(exc).__name__}: {exc}",
                {"source": _NAME, "exc_type": type(exc).__name__},
            ) from exc
        choices = getattr(response, "choices", None)
        if not choices:
            raise QuantError("LLM_FAILED", f"{_NAME}: response has no choices")
        message = getattr(choices[0], "message", None)
        content = getattr(message, "content", None) if message is not None else None
        if not isinstance(content, str):
            raise QuantError("LLM_FAILED", f"{_NAME}: response 'content' is not a string")
        return content
