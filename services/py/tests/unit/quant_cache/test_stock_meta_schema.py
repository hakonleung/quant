"""Unit tests for the stock-meta codec round-trip + validation."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from quant_cache.stock_meta_schema import (
    STOCK_META_KEY_FIELD,
    STOCK_META_SCHEMA,
    stock_meta_from_row,
    stock_meta_key,
    stock_meta_to_row,
)

from tests._util.stock_meta_fixtures import SEED


@pytest.mark.unit
class TestStockMetaCodec:
    def test_round_trip_preserves_all_fields(self) -> None:
        for item in SEED:
            row = stock_meta_to_row(item)
            again = stock_meta_from_row(row)
            assert again == item

    def test_key_of_returns_code(self) -> None:
        assert stock_meta_key(SEED[0]) == "600519"

    def test_to_row_emits_float_pct_as_decimal_string(self) -> None:
        row = stock_meta_to_row(SEED[0])
        assert isinstance(row["float_pct"], str)
        # Decimal(1) round-trips as "1" (no trailing ".0").
        assert row["float_pct"] == "1"

    def test_schema_key_field_constant_matches_schema(self) -> None:
        assert STOCK_META_KEY_FIELD in STOCK_META_SCHEMA.names

    def test_from_row_rejects_naive_datetime(self) -> None:
        row = dict(stock_meta_to_row(SEED[0]))
        row["updated_at"] = datetime(2026, 1, 1, 0, 0, 0)  # no tz
        with pytest.raises(ValueError, match="timezone-aware"):
            stock_meta_from_row(row)

    def test_from_row_rejects_non_date_list_date(self) -> None:
        row = dict(stock_meta_to_row(SEED[0]))
        row["list_date"] = "2026-01-01"  # string, not date
        with pytest.raises(ValueError, match="list_date"):
            stock_meta_from_row(row)

    def test_from_row_rejects_non_datetime_updated_at(self) -> None:
        row = dict(stock_meta_to_row(SEED[0]))
        row["updated_at"] = date(2026, 1, 1)  # date, not datetime
        with pytest.raises(ValueError, match="updated_at must be a datetime"):
            stock_meta_from_row(row)

    def test_industries_round_trips_as_string(self) -> None:
        row = stock_meta_to_row(SEED[0])
        assert isinstance(row["industries"], str)
        assert row["industries"] == "食品饮料,白酒"

    def test_round_trip_with_tz_aware_updated_at_in_utc(self) -> None:
        row = dict(stock_meta_to_row(SEED[0]))
        row["updated_at"] = datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC)
        again = stock_meta_from_row(row)
        assert again.updated_at.tzinfo is not None
