"""Python-side ConfigCenter — env-agnostic settings singleton.

The module itself never reads ``os.environ``. The bootstrap entrypoint
(:mod:`quant_rpc.main`) parses env into a dict and hands it to
:func:`init_settings`; every consumer thereafter reads via
:func:`get_settings`.

Hardcoded defaults (transport retry, parquet lock, slack timeout) live
inline below — no env knob, to mirror the TS ConfigCenter rule.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class Settings(BaseModel):
    """Top-level Python-side config.

    Required fields are env-driven (data root, log level, flight bind,
    US watch source). Everything else is hardcoded — see the ``Final``
    defaults baked into the field declarations.
    """

    model_config: dict[str, Any] = {"frozen": True}

    data_root: str = Field(default="./data")
    log_level: str = Field(default="INFO")
    flight_host: str = Field(default="127.0.0.1")
    flight_port: int = Field(default=8815, gt=0, le=65535)
    us_watch_source: str = Field(default="yfinance")

    # Hardcoded — no env override. Tuned empirically.
    transport_retry_delay_ms: int = Field(default=1000, gt=0)
    transport_retry_jitter_ms: int = Field(default=100, ge=0)
    slack_http_timeout_sec: float = Field(default=10.0, gt=0)
    parquet_lock_timeout_sec: float = Field(default=5.0, gt=0)


_settings: Settings | None = None


def init_settings(values: dict[str, Any] | None = None) -> Settings:
    """Bootstrap the global Settings singleton.

    ``values`` is a plain dict of overrides (caller is responsible for
    reading and parsing env). Pass ``None`` (or omit) to use hardcoded
    defaults — useful for tests and CLI shims.
    """
    global _settings
    _settings = Settings(**(values or {}))
    return _settings


def get_settings() -> Settings:
    """Return the singleton; raises if :func:`init_settings` hasn't run."""
    if _settings is None:
        raise RuntimeError(
            "ConfigCenter not initialised — call init_settings(...) at bootstrap"
        )
    return _settings


def reset_settings_cache() -> None:
    """Test seam — drop the singleton."""
    global _settings
    _settings = None
