"""Unit tests for pure notification routing/dedupe (modules/08 §8.1)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from quant_core.domain.pure.notification_route import (
    default_dedupe_key,
    match_rule,
)
from quant_core.domain.types.notification import Notification, Rule


def _n(
    *,
    source: str = "kline.sync",
    severity: str = "error",
    related_codes: tuple[str, ...] = (),
    dedupe_key: str | None = None,
    trace_id: str = "tr-1",
    created_at: datetime | None = None,
) -> Notification:
    return Notification(
        id="id-1",
        severity=severity,  # type: ignore[arg-type]
        title="t",
        body="b",
        source=source,
        trace_id=trace_id,
        created_at=created_at or datetime(2026, 5, 3, 12, 0, tzinfo=UTC),
        related_codes=related_codes,
        dedupe_key=dedupe_key,
    )


class TestMatchRule:
    def test_first_match_wins(self) -> None:
        r1 = Rule(source="kline.sync", severity_in=("error",), channels=("a",))
        r2 = Rule(source="kline.sync", severity_in=("error", "fatal"), channels=("b",))
        assert match_rule([r1, r2], _n()) is r1

    def test_severity_filter(self) -> None:
        r = Rule(source="llm.quota", severity_in=("warn",), channels=("x",))
        assert match_rule([r], _n(source="llm.quota", severity="error")) is None
        assert match_rule([r], _n(source="llm.quota", severity="warn")) is r

    def test_no_match_returns_none(self) -> None:
        r = Rule(source="kline.sync", severity_in=("error",), channels=("a",))
        assert match_rule([r], _n(source="other")) is None

    def test_empty_rules_returns_none(self) -> None:
        assert match_rule([], _n()) is None


class TestDefaultDedupeKey:
    def test_explicit_override_wins(self) -> None:
        n = _n(dedupe_key="custom")
        assert default_dedupe_key(n) == "custom"

    def test_kline_sync_keyed_by_date(self) -> None:
        n = _n(source="kline.sync", created_at=datetime(2026, 5, 3, 12, tzinfo=UTC))
        assert default_dedupe_key(n) == "kline.sync:2026-05-03"

    def test_screen_alert_uses_sorted_codes(self) -> None:
        n = _n(source="screen.alert", related_codes=("600519", "000001"))
        assert default_dedupe_key(n) == "screen.alert:000001,600519"

    def test_screen_alert_empty_codes(self) -> None:
        n = _n(source="screen.alert")
        assert default_dedupe_key(n) == "screen.alert:"

    def test_generic_fallback_to_trace_id(self) -> None:
        n = _n(source="custom.thing", trace_id="tr-99")
        assert default_dedupe_key(n) == "custom.thing:tr-99"


def test_severity_in_tuple_must_contain_severity_value() -> None:
    # Sanity: tuple membership is the rule, not equality.
    r = Rule(source="x", severity_in=("info", "warn"), channels=("a",))
    assert match_rule([r], _n(source="x", severity="info")) is r
    assert match_rule([r], _n(source="x", severity="error")) is None


def test_related_codes_immutable() -> None:
    n = _n(related_codes=("a", "b"))
    with pytest.raises(AttributeError):
        n.related_codes = ("c",)  # type: ignore[misc]
