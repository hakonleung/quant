"""Unit tests for :class:`AKShareStockMetaSource`."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from quant_core.errors import QuantError
from quant_io.sources.akshare_stock_meta import AKShareStockMetaSource

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping


class _FakeGateway:
    def __init__(self, rows: object) -> None:
        self._rows = rows

    def stock_info_a_code_name(self) -> Iterable[Mapping[str, object]]:
        if isinstance(self._rows, BaseException):
            raise self._rows
        assert isinstance(self._rows, list)
        return list(self._rows)


SAMPLE_ROWS: list[dict[str, object]] = [
    {"code": "600519", "name": "贵州茅台"},
    {"code": "000858", "name": "五粮液"},
    {"code": "300750", "name": "宁德时代"},
    {"code": "430047", "name": "诺思兰德"},
]


@pytest.mark.unit
class TestAKShareStockMetaHealthcheck:
    def test_unavailable_when_sdk_not_installed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import quant_io.sources.akshare_stock_meta as mod

        monkeypatch.setattr(mod, "lazy_import", lambda _: None)
        h = AKShareStockMetaSource().healthcheck()
        assert h.available is False
        assert h.last_error is not None
        assert "akshare" in h.last_error.lower()

    def test_available_with_injected_gateway(self) -> None:
        h = AKShareStockMetaSource(gateway=_FakeGateway(SAMPLE_ROWS)).healthcheck()
        assert h.available is True


@pytest.mark.unit
class TestAKShareStockMetaFetch:
    def test_fetch_all_tags_codes_with_correct_exchange(self) -> None:
        items = list(AKShareStockMetaSource(gateway=_FakeGateway(SAMPLE_ROWS)).fetch_all())
        codes = {m.code: m for m in items}
        assert codes["600519.SH"].exchange == "SH"
        assert codes["000858.SZ"].exchange == "SZ"
        assert codes["300750.SZ"].exchange == "SZ"
        assert codes["430047.BJ"].exchange == "BJ"

    def test_fetch_all_drops_malformed_codes(self) -> None:
        rows = [{"code": "not-a-code", "name": "x"}, {"code": "12345", "name": "y"}]
        items = list(AKShareStockMetaSource(gateway=_FakeGateway(rows)).fetch_all())
        assert items == []

    def test_fetch_all_drops_rows_with_missing_name(self) -> None:
        rows = [{"code": "600519", "name": ""}]
        items = list(AKShareStockMetaSource(gateway=_FakeGateway(rows)).fetch_all())
        assert items == []

    def test_fetch_all_translates_sdk_errors_to_quant_error(self) -> None:
        gw = _FakeGateway(RuntimeError("akshare flake"))
        with pytest.raises(QuantError) as excinfo:
            list(AKShareStockMetaSource(gateway=gw).fetch_all())
        assert excinfo.value.code == "SOURCE_UNAVAILABLE"

    def test_fetch_all_raises_when_sdk_missing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import quant_io.sources.akshare_stock_meta as mod

        monkeypatch.setattr(mod, "lazy_import", lambda _: None)
        with pytest.raises(QuantError):
            list(AKShareStockMetaSource().fetch_all())


@pytest.mark.unit
class TestAKShareStockMetaFetchOne:
    def test_returns_record_when_present(self) -> None:
        src = AKShareStockMetaSource(gateway=_FakeGateway(SAMPLE_ROWS))
        m = src.fetch_one("600519.SH")
        assert m is not None
        assert m.name == "贵州茅台"

    def test_returns_none_when_absent(self) -> None:
        src = AKShareStockMetaSource(gateway=_FakeGateway(SAMPLE_ROWS))
        assert src.fetch_one("999.XX") is None
