"""Unit tests for :class:`AKShareStockMetaSource`.

The real AKShare SDK is not available in CI; tests inject a fake gateway
that implements both endpoints (``stock_info_a_code_name`` and
``stock_individual_basic_info_xq``) so the adapter's row-mapping +
healthcheck logic is exercised without a network round-trip. The
lazy-import path (no SDK installed) is verified by stubbing
``lazy_import``.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from quant_core.errors import QuantError
from quant_io.sources.akshare_stock_meta import AKShareStockMetaSource


class _FakeGateway:
    """Implements both endpoints AKShare exposes so the Protocol matches."""

    def __init__(
        self,
        *,
        bulk: object | None = None,
        per_code: dict[str, object] | None = None,
        bulk_error: BaseException | None = None,
        per_code_error: BaseException | None = None,
    ) -> None:
        self._bulk = bulk
        self._per_code = per_code or {}
        self._bulk_error = bulk_error
        self._per_code_error = per_code_error
        self.xq_calls: list[str] = []

    def stock_info_a_code_name(self) -> object:
        if self._bulk_error is not None:
            raise self._bulk_error
        return self._bulk if self._bulk is not None else []

    def stock_individual_basic_info_xq(self, symbol: str) -> object:
        self.xq_calls.append(symbol)
        if self._per_code_error is not None:
            raise self._per_code_error
        return self._per_code.get(symbol, [])


SAMPLE_BULK_ROWS: list[dict[str, object]] = [
    {"code": "600519", "name": "贵州茅台"},  # SH main
    {"code": "688981", "name": "中芯国际"},  # SH STAR
    {"code": "000858", "name": "五粮液"},  # SZ main
    {"code": "300750", "name": "宁德时代"},  # SZ ChiNext
    {"code": "430047", "name": "诺思兰德"},  # BJ — legacy 4xx prefix
    {"code": "920992", "name": "中科美菱"},  # BJ — 920 prefix added 2024
]


def _xq_payload(
    *,
    name: str,
    listed_ms: int | None = None,
    industry: str | None = None,
    issue_vol: float | None = None,
) -> list[dict[str, object]]:
    """Build the [{item, value}, ...] shape the real XQ endpoint returns."""
    pairs: list[tuple[str, object]] = [
        ("org_short_name_cn", name),
        ("org_name_cn", f"{name}股份有限公司"),
    ]
    if listed_ms is not None:
        pairs.append(("listed_date", listed_ms))
    if industry is not None:
        pairs.append(("affiliate_industry", {"ind_code": "BK0088", "ind_name": industry}))
    if issue_vol is not None:
        pairs.append(("actual_issue_vol", issue_vol))
    return [{"item": k, "value": v} for k, v in pairs]


# -- healthcheck --------------------------------------------------------


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
        h = AKShareStockMetaSource(gateway=_FakeGateway(bulk=SAMPLE_BULK_ROWS)).healthcheck()
        assert h.available is True


# -- fetch_all (bulk listing) ------------------------------------------


@pytest.mark.unit
class TestAKShareStockMetaFetchAll:
    def test_emits_bare_six_digit_codes(self) -> None:
        src = AKShareStockMetaSource(gateway=_FakeGateway(bulk=SAMPLE_BULK_ROWS))
        codes = {m.code for m in src.fetch_all()}
        assert codes == {"600519", "688981", "000858", "300750", "430047", "920992"}

    def test_validates_codes_via_known_prefixes(self) -> None:
        # Regression: 920xxx is the post-2024 BJ prefix; the naive "9 → SH"
        # rule misclassified it. We still validate via the prefix map even
        # though the resulting StockMeta no longer carries the exchange.
        src = AKShareStockMetaSource(
            gateway=_FakeGateway(
                bulk=[
                    {"code": "920992", "name": "中科美菱"},  # valid BJ prefix
                    {"code": "100000", "name": "未知"},  # not a real A-share prefix
                ]
            )
        )
        codes = {m.code for m in src.fetch_all()}
        assert codes == {"920992"}

    def test_populates_pinyin_initials_from_name(self) -> None:
        src = AKShareStockMetaSource(gateway=_FakeGateway(bulk=SAMPLE_BULK_ROWS))
        codes = {m.code: m for m in src.fetch_all()}
        assert codes["600519"].name_pinyin == "GZMT"
        assert codes["300750"].name_pinyin == "NDSD"

    def test_industries_is_empty_string_for_bulk_records(self) -> None:
        # Bulk endpoint does not expose industry; enrichment via fetch_one fills it.
        src = AKShareStockMetaSource(gateway=_FakeGateway(bulk=SAMPLE_BULK_ROWS))
        for m in src.fetch_all():
            assert m.industries == ""

    def test_drops_malformed_codes(self) -> None:
        rows = [{"code": "not-a-code", "name": "x"}, {"code": "12345", "name": "y"}]
        src = AKShareStockMetaSource(gateway=_FakeGateway(bulk=rows))
        assert list(src.fetch_all()) == []

    def test_drops_rows_with_missing_name(self) -> None:
        src = AKShareStockMetaSource(gateway=_FakeGateway(bulk=[{"code": "600519", "name": ""}]))
        assert list(src.fetch_all()) == []

    def test_translates_sdk_errors_to_quant_error(self) -> None:
        src = AKShareStockMetaSource(gateway=_FakeGateway(bulk_error=RuntimeError("akshare flake")))
        with pytest.raises(QuantError) as excinfo:
            list(src.fetch_all())
        assert excinfo.value.code == "SOURCE_UNAVAILABLE"

    def test_raises_when_sdk_missing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import quant_io.sources.akshare_stock_meta as mod

        monkeypatch.setattr(mod, "lazy_import", lambda _: None)
        with pytest.raises(QuantError):
            list(AKShareStockMetaSource().fetch_all())


# -- fetch_one (XQ enrichment) -----------------------------------------


@pytest.mark.unit
class TestAKShareStockMetaFetchOne:
    def test_round_trips_xq_fields_into_meta(self) -> None:
        # 998841600000 ms = 2001-08-27 UTC
        gw = _FakeGateway(
            per_code={
                "SH600519": _xq_payload(
                    name="贵州茅台",
                    listed_ms=998841600000,
                    industry="白酒",
                    issue_vol=71500000.0,
                )
            }
        )
        src = AKShareStockMetaSource(gateway=gw)
        m = src.fetch_one("600519")
        assert m is not None
        assert m.code == "600519"
        assert m.name == "贵州茅台"
        assert m.name_pinyin == "GZMT"
        assert m.industries == "白酒"
        assert m.list_date.isoformat() == "2001-08-27"
        # XQ does not expose a separate restricted-share count; default
        # to fully-tradable (1) for now.
        assert m.float_pct == Decimal(1)
        # XQ symbol form: SH600519 — exchange prefix derived from code,
        # used only as transport plumbing (not stored on the meta).
        assert gw.xq_calls == ["SH600519"]

    def test_uses_org_name_cn_when_short_name_missing(self) -> None:
        gw = _FakeGateway(
            per_code={
                "SH600519": [
                    {"item": "org_name_cn", "value": "贵州茅台酒股份有限公司"},
                ]
            }
        )
        m = AKShareStockMetaSource(gateway=gw).fetch_one("600519")
        assert m is not None
        assert m.name == "贵州茅台酒股份有限公司"

    def test_returns_none_when_xq_payload_lacks_name(self) -> None:
        gw = _FakeGateway(per_code={"SH600519": []})
        assert AKShareStockMetaSource(gateway=gw).fetch_one("600519") is None

    def test_returns_none_for_non_six_digit_input(self) -> None:
        gw = _FakeGateway()
        # Inputs that aren't bare 6-digit codes are rejected before the
        # gateway is hit. The dotted-suffix form some old code used is
        # explicitly invalid.
        assert AKShareStockMetaSource(gateway=gw).fetch_one("600519.SH") is None
        assert AKShareStockMetaSource(gateway=gw).fetch_one("12345") is None
        assert AKShareStockMetaSource(gateway=gw).fetch_one("not-a-code") is None
        assert gw.xq_calls == []

    def test_returns_none_for_code_outside_known_prefix_ranges(self) -> None:
        gw = _FakeGateway()
        # 100xxx is a valid 6-digit string but not an A-share prefix.
        assert AKShareStockMetaSource(gateway=gw).fetch_one("100000") is None
        assert gw.xq_calls == []

    def test_translates_xq_sdk_errors_to_quant_error(self) -> None:
        gw = _FakeGateway(per_code_error=RuntimeError("xq down"))
        src = AKShareStockMetaSource(gateway=gw)
        with pytest.raises(QuantError) as excinfo:
            src.fetch_one("600519")
        assert excinfo.value.code == "SOURCE_UNAVAILABLE"

    def test_tolerates_missing_optional_fields(self) -> None:
        # Only the name is mandatory; everything else falls back to defaults.
        gw = _FakeGateway(per_code={"SH600519": _xq_payload(name="贵州茅台")})
        m = AKShareStockMetaSource(gateway=gw).fetch_one("600519")
        assert m is not None
        assert m.industries == ""
        # Sentinel partial date when XQ doesn't expose listed_date.
        assert m.list_date.isoformat() == "1990-01-01"
        assert m.float_pct == Decimal(1)

    def test_handles_string_nan_in_optional_fields(self) -> None:
        # Real XQ rows often contain the literal string "nan" for missing
        # values (pandas NaN → str cast in our normaliser).
        gw = _FakeGateway(
            per_code={
                "SH600519": [
                    {"item": "org_short_name_cn", "value": "贵州茅台"},
                    {"item": "listed_date", "value": "nan"},
                ]
            }
        )
        m = AKShareStockMetaSource(gateway=gw).fetch_one("600519")
        assert m is not None
        assert m.list_date.isoformat() == "1990-01-01"


# -- DataFrame normaliser ----------------------------------------------


@pytest.mark.unit
class TestAKShareDataFrameNormalisation:
    def test_pandas_like_to_dict_records_path(self) -> None:
        """Real akshare returns a DataFrame; we duck-type via to_dict."""

        class _FakeDataFrame:
            def to_dict(self, orient: str) -> object:
                assert orient == "records"
                return [{"code": "600519", "name": "贵州茅台"}]

        class _Gateway:
            def stock_info_a_code_name(self) -> object:
                return _FakeDataFrame()

            def stock_individual_basic_info_xq(self, symbol: str) -> object:
                del symbol
                return []

        items = list(AKShareStockMetaSource(gateway=_Gateway()).fetch_all())
        assert len(items) == 1
        assert items[0].code == "600519"

    def test_unsupported_container_raises_typeerror(self) -> None:
        class _Gateway:
            def stock_info_a_code_name(self) -> object:
                return "unexpected string return"

            def stock_individual_basic_info_xq(self, symbol: str) -> object:
                del symbol
                return []

        with pytest.raises(TypeError, match="unsupported container"):
            list(AKShareStockMetaSource(gateway=_Gateway()).fetch_all())
