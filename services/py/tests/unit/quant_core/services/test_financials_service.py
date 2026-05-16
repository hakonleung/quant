"""Tests for ``FinancialsService`` — bulk merge, per-stock merge.

Storage-unify: the service no longer persists. Tests assert the
returned :class:`StockMeta` payloads — the caller (NestJS) does the
write. ``_FakeRepo`` here is read-only, mirroring the production
:class:`StockMetaRepo` protocol.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from quant_core.domain.types.stock import QuarterlyFinancials, StockMeta
from quant_core.services.financials_service import FinancialsService
from quant_io.sources.akshare_financials import (
    FinancialsBulkPayload,
    FinancialsEnrichmentDelta,
)


class _FakeRepo:
    def __init__(self, items: list[StockMeta]) -> None:
        self._by_code: dict[str, StockMeta] = {m.code: m for m in items}

    def get(self, code: str) -> StockMeta | None:
        return self._by_code.get(code)

    def list_all(self) -> list[StockMeta]:
        return sorted(self._by_code.values(), key=lambda m: m.code)


class _FixedClock:
    def __init__(self, now: datetime) -> None:
        self._now = now

    def now(self) -> datetime:
        return self._now


class _FakeBulk:
    def __init__(self, payloads: dict[str, FinancialsBulkPayload]) -> None:
        self._payloads = payloads

    def fetch_recent(self, *, today: date, quarters: int = 8) -> dict[str, FinancialsBulkPayload]:
        del today, quarters
        return dict(self._payloads)


class _FakeEnricher:
    def __init__(self, by_code: dict[str, FinancialsEnrichmentDelta | None]) -> None:
        self._by_code = by_code

    def fetch_for(self, code: str) -> FinancialsEnrichmentDelta | None:
        return self._by_code.get(code)


def _meta(code: str = "600519", **overrides: object) -> StockMeta:
    base = StockMeta(
        code=code,
        name="贵州茅台",
        name_pinyin="GZMT",
        industries="食品饮料,白酒",
        list_date=date(2001, 8, 27),
        float_pct=Decimal("1"),
        updated_at=datetime(2025, 1, 1, tzinfo=UTC),
    )
    return base if not overrides else _replace(base, **overrides)


def _replace(meta: StockMeta, **overrides: object) -> StockMeta:
    from dataclasses import replace

    return replace(meta, **overrides)


# ---- bulk_refresh --------------------------------------------------------


class TestBulkRefresh:
    def test_returns_merged_rows_with_quarterlies_and_watermark(self) -> None:
        repo = _FakeRepo([_meta()])
        clock = _FixedClock(datetime(2026, 5, 1, tzinfo=UTC))
        bulk = _FakeBulk(
            {
                "600519": FinancialsBulkPayload(
                    code="600519",
                    quarterlies=(
                        QuarterlyFinancials(
                            period=date(2025, 9, 30),
                            revenue=Decimal("99000000000"),
                            operating_cost=None,
                            net_profit=Decimal("52000000000"),
                            net_profit_excl_nr=None,
                        ),
                    ),
                    net_assets_per_share=Decimal("200"),
                    net_assets_period=date(2025, 9, 30),
                ),
            }
        )
        svc = FinancialsService(repo=repo, clock=clock, bulk=bulk, enricher=_FakeEnricher({}))
        report = svc.bulk_refresh()
        assert report.fetched_codes == 1
        assert len(report.merged) == 1
        merged = report.merged[0]
        assert merged.code == "600519"
        assert merged.quarterlies[-1].revenue == Decimal("99000000000")
        assert merged.financials_updated_at == clock.now()
        # Repo unchanged — service is pure compute.
        assert repo.get("600519") == _meta()

    def test_orphan_codes_skipped(self) -> None:
        repo = _FakeRepo([])  # no meta rows
        clock = _FixedClock(datetime(2026, 5, 1, tzinfo=UTC))
        bulk = _FakeBulk(
            {
                "600519": FinancialsBulkPayload(
                    code="600519",
                    quarterlies=(),
                    net_assets_per_share=None,
                    net_assets_period=None,
                ),
            }
        )
        svc = FinancialsService(repo=repo, clock=clock, bulk=bulk, enricher=_FakeEnricher({}))
        report = svc.bulk_refresh()
        assert report.merged == ()

    def test_existing_extras_preserved_on_merge(self) -> None:
        # Slow-path enricher previously filled operating_cost — bulk must
        # not wipe it on the next cron tick.
        existing = _meta(
            quarterlies=(
                QuarterlyFinancials(
                    period=date(2025, 9, 30),
                    revenue=Decimal("90000000000"),
                    operating_cost=Decimal("11000000000"),
                    net_profit=Decimal("50000000000"),
                    net_profit_excl_nr=Decimal("49000000000"),
                ),
            ),
        )
        repo = _FakeRepo([existing])
        clock = _FixedClock(datetime(2026, 5, 1, tzinfo=UTC))
        bulk = _FakeBulk(
            {
                "600519": FinancialsBulkPayload(
                    code="600519",
                    quarterlies=(
                        QuarterlyFinancials(
                            period=date(2025, 9, 30),
                            revenue=Decimal("99000000000"),
                            operating_cost=None,
                            net_profit=Decimal("52000000000"),
                            net_profit_excl_nr=None,
                        ),
                    ),
                    net_assets_per_share=None,
                    net_assets_period=None,
                ),
            }
        )
        report = FinancialsService(
            repo=repo, clock=clock, bulk=bulk, enricher=_FakeEnricher({})
        ).bulk_refresh()
        merged = report.merged[0]
        latest = merged.quarterlies[-1]
        assert latest.revenue == Decimal("99000000000")  # bulk overrides
        assert latest.net_profit == Decimal("52000000000")
        assert latest.operating_cost == Decimal("11000000000")  # preserved
        assert latest.net_profit_excl_nr == Decimal("49000000000")

    def test_net_assets_only_set_when_total_share_known(self) -> None:
        # Without `total_share`, net_assets stays None.
        repo = _FakeRepo([_meta(total_share=None)])
        clock = _FixedClock(datetime(2026, 5, 1, tzinfo=UTC))
        bulk = _FakeBulk(
            {
                "600519": FinancialsBulkPayload(
                    code="600519",
                    quarterlies=(
                        QuarterlyFinancials(
                            period=date(2025, 9, 30),
                            revenue=Decimal("100"),
                            operating_cost=None,
                            net_profit=Decimal("40"),
                            net_profit_excl_nr=None,
                        ),
                    ),
                    net_assets_per_share=Decimal("20"),
                    net_assets_period=date(2025, 9, 30),
                ),
            }
        )
        merged = FinancialsService(
            repo=repo, clock=clock, bulk=bulk, enricher=_FakeEnricher({})
        ).bulk_refresh().merged[0]
        assert merged.net_assets is None

    def test_net_assets_computed_when_total_share_known(self) -> None:
        repo = _FakeRepo([_meta(total_share=Decimal("1000"))])
        clock = _FixedClock(datetime(2026, 5, 1, tzinfo=UTC))
        bulk = _FakeBulk(
            {
                "600519": FinancialsBulkPayload(
                    code="600519",
                    quarterlies=(
                        QuarterlyFinancials(
                            period=date(2025, 9, 30),
                            revenue=Decimal("100"),
                            operating_cost=None,
                            net_profit=Decimal("40"),
                            net_profit_excl_nr=None,
                        ),
                    ),
                    net_assets_per_share=Decimal("20"),
                    net_assets_period=date(2025, 9, 30),
                ),
            }
        )
        merged = FinancialsService(
            repo=repo, clock=clock, bulk=bulk, enricher=_FakeEnricher({})
        ).bulk_refresh().merged[0]
        assert merged.net_assets == Decimal("20000")
        assert merged.net_assets_period == date(2025, 9, 30)


# ---- enrich_one ----------------------------------------------------------


class TestEnrichOne:
    def test_returns_merged_meta_with_share_counts_and_extras(self) -> None:
        existing = _meta(
            quarterlies=(
                QuarterlyFinancials(
                    period=date(2025, 9, 30),
                    revenue=Decimal("100"),
                    operating_cost=None,
                    net_profit=Decimal("40"),
                    net_profit_excl_nr=None,
                ),
            ),
        )
        repo = _FakeRepo([existing])
        clock = _FixedClock(datetime(2026, 5, 1, tzinfo=UTC))
        delta = FinancialsEnrichmentDelta(
            code="600519",
            total_share=Decimal("2000"),
            float_share=Decimal("1500"),
            operating_cost_by_period={date(2025, 9, 30): Decimal("40")},
            net_profit_excl_nr_by_period={date(2025, 9, 30): Decimal("38")},
        )
        svc = FinancialsService(
            repo=repo,
            clock=clock,
            bulk=_FakeBulk({}),
            enricher=_FakeEnricher({"600519": delta}),
        )
        merged = svc.enrich_one("600519")
        assert merged is not None
        assert merged.total_share == Decimal("2000")
        assert merged.float_share == Decimal("1500")
        assert merged.float_pct == Decimal("0.75")
        latest = merged.quarterlies[-1]
        assert latest.operating_cost == Decimal("40")
        assert latest.net_profit_excl_nr == Decimal("38")
        # Repo untouched — caller persists.
        assert repo.get("600519") == existing

    def test_unknown_code_returns_none(self) -> None:
        repo = _FakeRepo([])
        svc = FinancialsService(
            repo=repo,
            clock=_FixedClock(datetime(2026, 5, 1, tzinfo=UTC)),
            bulk=_FakeBulk({}),
            enricher=_FakeEnricher({}),
        )
        assert svc.enrich_one("600519") is None

    def test_no_delta_returns_none(self) -> None:
        repo = _FakeRepo([_meta()])
        svc = FinancialsService(
            repo=repo,
            clock=_FixedClock(datetime(2026, 5, 1, tzinfo=UTC)),
            bulk=_FakeBulk({}),
            enricher=_FakeEnricher({"600519": None}),
        )
        assert svc.enrich_one("600519") is None
