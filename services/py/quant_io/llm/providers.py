"""Hardcoded LLM-provider catalog + selection logic.

CLAUDE.md §1.4 forbids reading credentials inside core code, but the
provider *catalog* (which models exist, which support web-search, what
the OpenAI-compatible base URL is) is design-time data, not a secret.
We hardcode it here so a fresh checkout works without YAML / TOML
gymnastics, and only the per-provider API key is sourced from env.

Usage::

    client = build_llm_client()                       # primary, no web-search
    client = build_llm_client(tier="flash")           # cheap/fast model
    client = build_llm_client(need_web_search=True)   # filter to pro-web-search

The list order is the priority. ``build_llm_client`` walks the list,
filters by web-search if requested, and returns the first provider whose
``api_key_env`` is set in ``os.environ``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from quant_io.llm.openai_compatible import OpenAiCompatibleLlmClient


Tier = Literal["pro", "flash"]


@dataclass(frozen=True, slots=True)
class LlmProviderConfig:
    """One row in :data:`LLM_PROVIDERS`."""

    provider: str
    """Stable identifier (lower-case). Used in logs and as the client
    ``name``."""
    model_pro: str
    """High-quality model — default for DSL translation."""
    model_flash: str
    """Cheap / fast model — for short-form prompts where latency wins."""
    is_pro_web_search: bool
    """Whether ``model_pro`` natively supports web search via the
    OpenAI-compatible chat endpoint."""
    base_url: str
    """OpenAI-compatible base URL."""
    api_key_env: str
    """Environment variable name where the API key lives."""


LLM_PROVIDERS: Final[tuple[LlmProviderConfig, ...]] = (
    LlmProviderConfig(
        provider="deepseek",
        model_pro="deepseek-v4-pro",
        model_flash="deepseek-v4-flash",
        is_pro_web_search=False,
        base_url="https://api.deepseek.com",
        api_key_env="DEEPSEEK_API_KEY",
    ),
    LlmProviderConfig(
        provider="moonshot",
        model_pro="kimi-k2.6",
        model_flash="moonshot-v1-8k",
        is_pro_web_search=True,
        base_url="https://api.moonshot.cn/v1",
        api_key_env="MOONSHOT_API_KEY",
    ),
)
"""Priority-ordered list of LLM providers we know about."""


def select_provider(*, need_web_search: bool = False) -> tuple[LlmProviderConfig, str]:
    """Pick the first eligible provider whose API key is in env.

    Args:
        need_web_search: when ``True``, restrict to providers whose
            ``is_pro_web_search`` is ``True``.

    Returns:
        ``(config, api_key)`` for the chosen provider.

    Raises:
        QuantError: ``LLM_FAILED`` if no provider in the catalog matches
            the filter and has its API key set.
    """
    candidates = [cfg for cfg in LLM_PROVIDERS if not need_web_search or cfg.is_pro_web_search]
    if not candidates:
        raise QuantError(
            "LLM_FAILED",
            "no provider in catalog supports the requested capability",
            {"need_web_search": need_web_search},
        )
    missing: list[str] = []
    for cfg in candidates:
        api_key = os.environ.get(cfg.api_key_env)
        if api_key:
            return cfg, api_key
        missing.append(cfg.api_key_env)
    raise QuantError(
        "LLM_FAILED",
        "no LLM API key set in env (tried: " + ", ".join(missing) + ")",
        {"need_web_search": need_web_search, "tried": missing},
    )


def build_llm_client(
    *,
    tier: Tier = "pro",
    need_web_search: bool = False,
) -> OpenAiCompatibleLlmClient:
    """Construct an LLM client honouring the catalog priority.

    Args:
        tier: ``"pro"`` (default) → ``model_pro``; ``"flash"`` → cheap model.
        need_web_search: see :func:`select_provider`.

    Returns:
        A ready-to-call :class:`LLMClient` adapter.

    Raises:
        QuantError: ``LLM_FAILED`` from :func:`select_provider`.
    """
    from quant_io.llm.openai_compatible import OpenAiCompatibleLlmClient

    cfg, api_key = select_provider(need_web_search=need_web_search)
    model = cfg.model_pro if tier == "pro" else cfg.model_flash
    return OpenAiCompatibleLlmClient(
        provider_name=cfg.provider,
        base_url=cfg.base_url,
        model=model,
        api_key=api_key,
    )
