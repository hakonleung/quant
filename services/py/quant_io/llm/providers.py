"""Hardcoded LLM-provider catalog + selection logic.

CLAUDE.md §1.4 forbids reading credentials inside core code, but the
provider *catalog* (which models exist, which support web-search, what
the OpenAI-compatible base URL is) is design-time data, not a secret.
We hardcode it here so a fresh checkout works without YAML / TOML
gymnastics, and only the per-provider API key is sourced from env.

Selection priority used by :func:`build_llm_client`:

1. ``need_web_search=True`` → first provider with ``is_pro_web_search=True``
   (and an API key in env), use its ``model_pro``.
2. ``use_flash=True`` → first provider that *defines* ``model_flash``
   (and an API key in env), use its ``model_flash``.
3. otherwise → first provider with an API key in env, use ``model_pro``.

The list order is the user-visible priority. ``model_flash`` is
optional — providers that don't expose a cheap tier just leave it
``None`` and are skipped when ``use_flash=True``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Callable

    from quant_io.llm.fallback import FallbackLlmClient
    from quant_io.llm.openai_compatible import OpenAiCompatibleLlmClient


WebSearchKind = Literal["moonshot_tool", "qwen_extra_body"]
"""How the provider exposes web search:

* ``moonshot_tool``: Kimi-style ``$web_search`` builtin_function tool loop.
* ``qwen_extra_body``: Qwen (Alibaba DashScope OpenAI-compatible endpoint)
  — single chat call with ``extra_body={"enable_search": True}``; the
  platform folds search results into the assistant reply transparently.
"""


@dataclass(frozen=True, slots=True)
class LlmProviderConfig:
    """One row in :data:`LLM_PROVIDERS`."""

    provider: str
    """Stable identifier (lower-case). Used in logs and as the client
    ``name``."""
    model_pro: str
    """High-quality model — default for DSL translation."""
    is_pro_web_search: bool
    """Whether ``model_pro`` natively supports web search via the
    OpenAI-compatible chat endpoint."""
    base_url: str
    """OpenAI-compatible base URL."""
    api_key_env: str
    """Environment variable name where the API key lives."""
    model_flash: str | None = None
    """Cheap / fast model — optional. When unset, the provider is
    skipped under ``use_flash=True``."""
    web_search_kind: WebSearchKind = "moonshot_tool"
    """Which on-the-wire web-search protocol the adapter should drive when
    ``is_pro_web_search=True``. Ignored when web search is not requested."""


LLM_PROVIDERS: Final[tuple[LlmProviderConfig, ...]] = (
    LlmProviderConfig(
        provider="qwen",
        model_pro="qwen-plus",
        model_flash="qwen-turbo",
        is_pro_web_search=True,
        web_search_kind="qwen_extra_body",
        # OpenAI-compatible endpoint hosted on Alibaba DashScope; the
        # hostname is fixed by the vendor and unrelated to the local
        # provider identifier above.
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key_env="QWEN_API_KEY",
    ),
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
        is_pro_web_search=True,
        web_search_kind="moonshot_tool",
        base_url="https://api.moonshot.cn/v1",
        api_key_env="MOONSHOT_API_KEY",
    ),
)
"""Priority-ordered list of LLM providers we know about."""


def _ordered_candidates(
    predicate: Callable[[LlmProviderConfig], bool],
    *,
    prefer_provider: str | None,
) -> list[LlmProviderConfig]:
    """Return providers passing ``predicate`` with ``prefer_provider``
    (when present and matching) moved to the front. Order otherwise
    follows the static catalog priority."""
    matched = [cfg for cfg in LLM_PROVIDERS if predicate(cfg)]
    if prefer_provider is None:
        return matched
    head: list[LlmProviderConfig] = []
    tail: list[LlmProviderConfig] = []
    for cfg in matched:
        if cfg.provider == prefer_provider:
            head.append(cfg)
        else:
            tail.append(cfg)
    return head + tail


def _first_eligible(
    predicate: Callable[[LlmProviderConfig], bool],
    *,
    label: str,
    prefer_provider: str | None = None,
) -> tuple[LlmProviderConfig, str]:
    """Walk the catalog in priority order, return the first row passing
    ``predicate`` whose API key is set in ``os.environ``.

    When ``prefer_provider`` is given, that provider is tried first.
    If its key is missing we fall back to the static catalog order
    rather than raising — keeping ``build_llm_client`` permissive lets
    the ``ta`` chain factory still build a usable client when the
    preferred provider is offline.
    """
    candidates = _ordered_candidates(predicate, prefer_provider=prefer_provider)
    if not candidates:
        raise QuantError(
            "LLM_FAILED",
            f"no provider in catalog satisfies {label}",
            {"selector": label},
        )
    tried: list[str] = []
    for cfg in candidates:
        api_key = os.environ.get(cfg.api_key_env)
        if api_key:
            return cfg, api_key
        tried.append(cfg.api_key_env)
    raise QuantError(
        "LLM_FAILED",
        f"no API key set for any {label} provider (tried: {', '.join(tried)})",
        {"selector": label, "tried": tried},
    )


def build_llm_client(
    *,
    need_web_search: bool = False,
    use_flash: bool = False,
    prefer_provider: str | None = None,
) -> OpenAiCompatibleLlmClient:
    """Construct an LLM client honouring the catalog priority.

    Args:
        need_web_search: filter to providers with ``is_pro_web_search=True``;
            uses ``model_pro``. Mutually exclusive with ``use_flash``.
        use_flash: pick the first provider that defines ``model_flash``;
            uses that cheaper model.
        prefer_provider: when set, try this provider's row first. If the
            named provider has no API key in env, the function silently
            falls back to the static catalog priority — callers wanting
            strict pinning should check ``client.name`` after construction.
            Must match a real catalog ``provider`` value when given.

    Returns:
        A ready-to-call OpenAI-compatible :class:`LLMClient` adapter.

    Raises:
        QuantError: ``LLM_FAILED`` when no provider in the catalog
            matches the requested capability, when no matching provider
            has its API key set, or when ``prefer_provider`` is given
            with a value that is not in the catalog.
    """
    from quant_io.llm.openai_compatible import OpenAiCompatibleLlmClient

    if need_web_search and use_flash:
        raise QuantError(
            "LLM_FAILED",
            "need_web_search and use_flash are mutually exclusive",
        )
    if prefer_provider is not None and not any(
        c.provider == prefer_provider for c in LLM_PROVIDERS
    ):
        raise QuantError(
            "LLM_FAILED",
            f"unknown prefer_provider {prefer_provider!r}",
            {"prefer_provider": prefer_provider},
        )
    if need_web_search:
        cfg, api_key = _first_eligible(
            lambda c: c.is_pro_web_search,
            label="is_pro_web_search",
            prefer_provider=prefer_provider,
        )
        model = cfg.model_pro
    elif use_flash:
        cfg, api_key = _first_eligible(
            lambda c: c.model_flash is not None,
            label="has_model_flash",
            prefer_provider=prefer_provider,
        )
        # Narrowed by the predicate; assert keeps mypy happy.
        assert cfg.model_flash is not None
        model = cfg.model_flash
    else:
        cfg, api_key = _first_eligible(
            lambda _c: True, label="any", prefer_provider=prefer_provider
        )
        model = cfg.model_pro
    return OpenAiCompatibleLlmClient(
        provider_name=cfg.provider,
        base_url=cfg.base_url,
        model=model,
        api_key=api_key,
        web_search_kind=cfg.web_search_kind,
    )


def build_llm_client_chain(
    *,
    use_flash: bool = False,
    prefer_provider: str | None = None,
) -> FallbackLlmClient:
    """Construct a fallback chain over every provider with an API key.

    The chain order is ``prefer_provider`` (if any and matched) followed
    by the static catalog order. ``need_web_search`` is intentionally not
    accepted: web-search backends are not chain-friendly (mid-loop
    fallback would re-do every search) and the only current caller (the
    ``ta`` service) does not need search.

    Args:
        use_flash: build each client around ``model_flash`` rather than
            ``model_pro``. Providers without a ``model_flash`` are
            skipped.
        prefer_provider: see :func:`build_llm_client`.

    Returns:
        A :class:`FallbackLlmClient` wrapping at least one usable
        adapter.

    Raises:
        QuantError: ``LLM_FAILED`` when ``prefer_provider`` is unknown,
            no candidate provider satisfies the capability filter, or
            none of the candidates have an API key in env.
    """
    from quant_io.llm.fallback import FallbackLlmClient
    from quant_io.llm.openai_compatible import OpenAiCompatibleLlmClient

    if prefer_provider is not None and not any(
        c.provider == prefer_provider for c in LLM_PROVIDERS
    ):
        raise QuantError(
            "LLM_FAILED",
            f"unknown prefer_provider {prefer_provider!r}",
            {"prefer_provider": prefer_provider},
        )
    predicate: Callable[[LlmProviderConfig], bool] = (
        (lambda c: c.model_flash is not None) if use_flash else (lambda _c: True)
    )
    label = "has_model_flash" if use_flash else "any"
    candidates = _ordered_candidates(predicate, prefer_provider=prefer_provider)
    if not candidates:
        raise QuantError(
            "LLM_FAILED",
            f"no provider in catalog satisfies {label}",
            {"selector": label},
        )
    clients: list[OpenAiCompatibleLlmClient] = []
    tried: list[str] = []
    for cfg in candidates:
        api_key = os.environ.get(cfg.api_key_env)
        if not api_key:
            tried.append(cfg.api_key_env)
            continue
        if use_flash:
            assert cfg.model_flash is not None
            model = cfg.model_flash
        else:
            model = cfg.model_pro
        clients.append(
            OpenAiCompatibleLlmClient(
                provider_name=cfg.provider,
                base_url=cfg.base_url,
                model=model,
                api_key=api_key,
                web_search_kind=cfg.web_search_kind,
            )
        )
    if not clients:
        raise QuantError(
            "LLM_FAILED",
            f"no API key set for any {label} provider (tried: {', '.join(tried)})",
            {"selector": label, "tried": tried},
        )
    return FallbackLlmClient(clients)
