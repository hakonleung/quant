"""GENERATED FILE — DO NOT EDIT BY HAND.

Source: proto/errors.json
Regenerate: pnpm gen:proto
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Final, Literal

ErrorCode = Literal[
    "OK",
    "INVALID_ARGUMENT",
    "NOT_FOUND",
    "STOCK_NOT_FOUND",
    "META_STALE",
    "KLINE_DATA_MISSING",
    "DSL_INVALID",
    "NL_TRANSLATION_FAILED",
    "EVALUATION_FAILED",
    "UNIVERSE_TOO_LARGE",
    "PATTERN_REFERENCE_LOOKAHEAD",
    "SOURCE_UNAVAILABLE",
    "RATE_LIMITED",
    "LLM_FAILED",
    "CACHE_CORRUPTED",
    "CACHE_KEY_NOT_FOUND",
    "CACHE_BACKEND_UNAVAILABLE",
    "INTERNAL",
]
"""Closed set of cross-process error codes (proto/errors.json)."""

ERROR_CODES: Final[frozenset[ErrorCode]] = frozenset(
    (
        "OK",
        "INVALID_ARGUMENT",
        "NOT_FOUND",
        "STOCK_NOT_FOUND",
        "META_STALE",
        "KLINE_DATA_MISSING",
        "DSL_INVALID",
        "NL_TRANSLATION_FAILED",
        "EVALUATION_FAILED",
        "UNIVERSE_TOO_LARGE",
        "PATTERN_REFERENCE_LOOKAHEAD",
        "SOURCE_UNAVAILABLE",
        "RATE_LIMITED",
        "LLM_FAILED",
        "CACHE_CORRUPTED",
        "CACHE_KEY_NOT_FOUND",
        "CACHE_BACKEND_UNAVAILABLE",
        "INTERNAL",
    )
)

ERROR_NUMBERS: Final[MappingProxyType[ErrorCode, int]] = MappingProxyType({
    "OK": 0,
    "INVALID_ARGUMENT": 1,
    "NOT_FOUND": 2,
    "STOCK_NOT_FOUND": 100,
    "META_STALE": 101,
    "KLINE_DATA_MISSING": 102,
    "DSL_INVALID": 200,
    "NL_TRANSLATION_FAILED": 201,
    "EVALUATION_FAILED": 202,
    "UNIVERSE_TOO_LARGE": 203,
    "PATTERN_REFERENCE_LOOKAHEAD": 300,
    "SOURCE_UNAVAILABLE": 400,
    "RATE_LIMITED": 401,
    "LLM_FAILED": 500,
    "CACHE_CORRUPTED": 600,
    "CACHE_KEY_NOT_FOUND": 601,
    "CACHE_BACKEND_UNAVAILABLE": 602,
    "INTERNAL": 999,
})

ERROR_HTTP_STATUS: Final[MappingProxyType[ErrorCode, int]] = MappingProxyType({
    "OK": 200,
    "INVALID_ARGUMENT": 400,
    "NOT_FOUND": 404,
    "STOCK_NOT_FOUND": 404,
    "META_STALE": 503,
    "KLINE_DATA_MISSING": 503,
    "DSL_INVALID": 400,
    "NL_TRANSLATION_FAILED": 502,
    "EVALUATION_FAILED": 500,
    "UNIVERSE_TOO_LARGE": 400,
    "PATTERN_REFERENCE_LOOKAHEAD": 400,
    "SOURCE_UNAVAILABLE": 503,
    "RATE_LIMITED": 503,
    "LLM_FAILED": 502,
    "CACHE_CORRUPTED": 500,
    "CACHE_KEY_NOT_FOUND": 404,
    "CACHE_BACKEND_UNAVAILABLE": 503,
    "INTERNAL": 500,
})
