"""Compatibility shim for callers that still import :class:`DeepSeekClient`.

New code should call :func:`quant_io.llm.providers.build_llm_client` so
the priority-ordered catalog (DeepSeek → OpenAI → Moonshot → ...) drives
selection. This shim stays alive for existing tests and notebooks that
constructed the DeepSeek client directly.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Final

from quant_core.errors import QuantError

from quant_io.llm.openai_compatible import OpenAiCompatibleLlmClient
from quant_io.llm.providers import LLM_PROVIDERS

if TYPE_CHECKING:
    from openai import OpenAI


_PROVIDER_NAME: Final[str] = "deepseek"


def _deepseek_config() -> tuple[str, str, str]:
    """Pick the DeepSeek catalog row and return ``(model_pro, base_url, env)``."""
    for cfg in LLM_PROVIDERS:
        if cfg.provider == _PROVIDER_NAME:
            return cfg.model_pro, cfg.base_url, cfg.api_key_env
    raise QuantError(
        "LLM_FAILED",
        "deepseek provider missing from LLM_PROVIDERS catalog",
    )


class DeepSeekClient(OpenAiCompatibleLlmClient):
    """Thin specialisation of the generic OpenAI-compatible client."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
        timeout_sec: float = 60.0,
        client: OpenAI | None = None,
    ) -> None:
        default_model, default_base_url, env_var = _deepseek_config()
        key = api_key or os.environ.get(env_var)
        if not key:
            raise QuantError(
                "LLM_FAILED",
                f"DeepSeek API key missing (set {env_var} or pass api_key=)",
                {"source": _PROVIDER_NAME},
            )
        super().__init__(
            provider_name=_PROVIDER_NAME,
            base_url=base_url or default_base_url,
            model=model or default_model,
            api_key=key,
            timeout_sec=timeout_sec,
            client=client,
        )
