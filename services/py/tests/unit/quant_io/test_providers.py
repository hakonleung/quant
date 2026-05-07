"""Unit tests for ``build_llm_client`` / ``build_llm_client_chain``.

Covers:
* prefer_provider hits the chosen row first.
* Missing preferred key → falls back to the static catalog priority.
* Mutually-exclusive flag combinations raise.
* Unknown ``prefer_provider`` raises.
* Chain factory builds one client per provider with a key.
"""

from __future__ import annotations

import pytest
from quant_core.errors import QuantError
from quant_io.llm.providers import build_llm_client, build_llm_client_chain

_LLM_KEY_ENVS: tuple[str, ...] = ("QWEN_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY")


@pytest.fixture(autouse=True)
def _scrub_llm_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each test starts with all LLM key env vars unset; tests opt-in.

    ``monkeypatch.delenv`` restores the prior value at teardown
    automatically — no manual cleanup loop required.
    """
    for name in _LLM_KEY_ENVS:
        monkeypatch.delenv(name, raising=False)


def test_build_llm_client_prefers_moonshot_when_key_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    monkeypatch.setenv("MOONSHOT_API_KEY", "moonshot-key")
    client = build_llm_client(prefer_provider="moonshot")
    assert client.name == "moonshot"
    assert client.model == "kimi-k2.6"


def test_build_llm_client_falls_back_when_preferred_key_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Moonshot is preferred but its key is not set; qwen wins by catalog order.
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    client = build_llm_client(prefer_provider="moonshot")
    assert client.name == "qwen"


def test_build_llm_client_raises_when_no_keys() -> None:
    with pytest.raises(QuantError) as excinfo:
        build_llm_client(prefer_provider="moonshot")
    assert excinfo.value.code == "LLM_FAILED"


def test_build_llm_client_rejects_unknown_prefer_provider() -> None:
    with pytest.raises(QuantError) as excinfo:
        build_llm_client(prefer_provider="bogus")
    assert excinfo.value.code == "LLM_FAILED"
    assert "bogus" in str(excinfo.value)


def test_build_llm_client_rejects_mutually_exclusive_flags() -> None:
    with pytest.raises(QuantError):
        build_llm_client(need_web_search=True, use_flash=True)


def test_build_llm_client_chain_orders_preferred_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-key")
    monkeypatch.setenv("MOONSHOT_API_KEY", "moonshot-key")
    chain = build_llm_client_chain(prefer_provider="moonshot")
    names = [c.name for c in chain.clients]
    assert names[0] == "moonshot"
    assert set(names) == {"qwen", "deepseek", "moonshot"}


def test_build_llm_client_chain_skips_providers_without_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("QWEN_API_KEY", "qwen-key")
    chain = build_llm_client_chain(prefer_provider="moonshot")
    assert [c.name for c in chain.clients] == ["qwen"]


def test_build_llm_client_chain_raises_when_no_keys() -> None:
    with pytest.raises(QuantError) as excinfo:
        build_llm_client_chain(prefer_provider="moonshot")
    assert excinfo.value.code == "LLM_FAILED"


def test_build_llm_client_chain_use_flash_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # moonshot has no model_flash → should be skipped under use_flash=True.
    monkeypatch.setenv("MOONSHOT_API_KEY", "moonshot-key")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-key")
    chain = build_llm_client_chain(prefer_provider="moonshot", use_flash=True)
    names = [c.name for c in chain.clients]
    assert "moonshot" not in names
    assert names == ["deepseek"]
