"""Unit tests for :class:`TushareStockMetaSource`.

The real Tushare SDK is not installed in CI; tests inject a fake gateway
to exercise the adapter's row-mapping + healthcheck logic without a
network round-trip. The lazy-import path (no SDK installed) is verified
by leaving ``gateway=None`` and ensuring healthcheck reports unavailable.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from quant_core.errors import QuantError
from quant_io.sources.tushare_stock_meta import TushareStockMetaSource

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping


class _FakeGateway:
    def __init__(self, rows: object) -> None:
        self._rows = rows
        self.calls = 0

    def stock_basic(self, **kwargs: object) -> Iterable[Mapping[str, object]]:
        self.calls += 1
        del kwargs
        if isinstance(self._rows, BaseException):
            raise self._rows
        assert isinstance(self._rows, list)
        return list(self._rows)


SAMPLE_ROWS: list[dict[str, object]] = [
    {
        "ts_code": "600519.SH",
        "name": "贵州茅台",
        "exchange": "SSE",
        "industry": "白酒",
        "list_date": "20010827",
        "delist_date": None,
        "total_share": "1256197800",
        "float_share": "1256197800",
    },
    {
        "ts_code": "000858.SZ",
        "name": "五粮液",
        "exchange": "SZSE",
        "industry": "白酒",
        "list_date": "19980427",
        "delist_date": None,
        "total_share": "3881608700",
        "float_share": "3881608700",
    },
]


@pytest.mark.unit
class TestTushareStockMetaHealthcheck:
    def test_unavailable_when_token_missing_and_no_gateway(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("TUSHARE_TOKEN", raising=False)
        h = TushareStockMetaSource().healthcheck()
        assert h.available is False
        assert h.last_error is not None
        assert "TUSHARE_TOKEN" in h.last_error

    def test_unavailable_when_sdk_not_installed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("TUSHARE_TOKEN", "stub")

        # Emulate "tushare not installed" by short-circuiting lazy_import.
        import quant_io.sources.tushare_stock_meta as mod

        monkeypatch.setattr(mod, "lazy_import", lambda _: None)
        h = TushareStockMetaSource().healthcheck()
        assert h.available is False
        assert h.last_error is not None
        assert "tushare" in h.last_error.lower()

    def test_available_with_injected_gateway(self) -> None:
        src = TushareStockMetaSource(gateway=_FakeGateway(SAMPLE_ROWS))
        h = src.healthcheck()
        assert h.available is True
        assert h.last_error is None


@pytest.mark.unit
class TestTushareStockMetaFetch:
    def test_fetch_all_maps_rows_to_meta(self) -> None:
        src = TushareStockMetaSource(gateway=_FakeGateway(SAMPLE_ROWS))
        items = list(src.fetch_all())
        assert {m.code for m in items} == {"600519.SH", "000858.SZ"}
        moutai = next(m for m in items if m.code == "600519.SH")
        assert moutai.exchange == "SH"
        assert moutai.industry_sw_l2 == "白酒"
        assert moutai.list_date.isoformat() == "2001-08-27"
        assert moutai.status == "NORMAL"
        assert int(moutai.total_share) == 1256197800

    def test_fetch_all_drops_rows_missing_required_fields(self) -> None:
        rows = [
            {"ts_code": "600519.SH", "name": "贵州茅台"},  # missing exchange + list_date
            *SAMPLE_ROWS,
        ]
        src = TushareStockMetaSource(gateway=_FakeGateway(rows))
        items = list(src.fetch_all())
        assert len(items) == 2  # the malformed row was dropped silently

    def test_fetch_all_translates_sdk_errors_to_quant_error(self) -> None:
        gw = _FakeGateway(RuntimeError("network blew up"))
        src = TushareStockMetaSource(gateway=gw)
        with pytest.raises(QuantError) as excinfo:
            list(src.fetch_all())
        assert excinfo.value.code == "SOURCE_UNAVAILABLE"
        assert "network blew up" in str(excinfo.value)

    def test_fetch_all_raises_when_no_gateway_and_no_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("TUSHARE_TOKEN", raising=False)
        with pytest.raises(QuantError) as excinfo:
            list(TushareStockMetaSource().fetch_all())
        assert excinfo.value.code == "SOURCE_UNAVAILABLE"

    def test_delisted_status_mapped_when_delist_date_present(self) -> None:
        row = dict(SAMPLE_ROWS[0])
        row["delist_date"] = "20231231"
        row["ts_code"] = "999999.SH"
        src = TushareStockMetaSource(gateway=_FakeGateway([row]))
        item = next(iter(src.fetch_all()))
        assert item.status == "DELISTED"
        assert item.delist_date is not None
        assert item.delist_date.isoformat() == "2023-12-31"


@pytest.mark.unit
class TestTushareStockMetaFetchOne:
    def test_returns_record_when_present(self) -> None:
        src = TushareStockMetaSource(gateway=_FakeGateway(SAMPLE_ROWS))
        m = src.fetch_one("600519.SH")
        assert m is not None
        assert m.code == "600519.SH"

    def test_returns_none_when_absent(self) -> None:
        src = TushareStockMetaSource(gateway=_FakeGateway(SAMPLE_ROWS))
        assert src.fetch_one("999.XX") is None
