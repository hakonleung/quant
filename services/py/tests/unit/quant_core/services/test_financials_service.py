"""Tests for ``FinancialsService`` — bulk merge, per-stock merge, watermark.

Uses fake bulk source / per-stock enricher (just dataclass-shaped
return objects) so we don't have to touch akshare. The repo + clock
ports use simple in-memory implementations so the test asserts the
final ``StockMeta`` shape after merge.
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
        self.upserts: list[list[StockMeta]] = []

    def upsert_many(self, items: list[StockMeta]) -> None:
        self.upserts.append(list(items))
        for m in items:
            self._by_code[m.code] = m

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

    def fetch_recent(
        self, *, today: date, quarters: int = 8
    ) -> dict[str, FinancialsBulkPayload]:
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
    def test_writes_quarterlies_and_watermark(self) -> None:
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
        svc = FinancialsService(
            repo=repo, clock=clock, bulk=bulk, enricher=_FakeEnricher({})
        )
        report = svc.bulk_refresh()
        assert report.fetched_codes == 1
        assert report.updated_codes == 1
        stored = repo.get("600519")
        assert stored is not None
        assert stored.quarterlies[-1].revenue == Decimal("99000000000")
        assert stored.financials_updated_at == clock.now()

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
        svc = FinancialsService(
            repo=repo, clock=clock, bulk=bulk, enricher=_FakeEnricher({})
        )
        report = svc.bulk_refresh()
        assert report.updated_codes == 0
        assert repo.upserts == []

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
        FinancialsService(
            repo=repo, clock=clock, bulk=bulk, enricher=_FakeEnricher({})
        ).bulk_refresh()
        stored = repo.get("600519")
        assert stored is not None
        latest = stored.quarterlies[-1]
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
        FinancialsService(
            repo=repo, clock=clock, bulk=bulk, enricher=_FakeEnricher({})
        ).bulk_refresh()
        stored = repo.get("600519")
        assert stored is not None and stored.net_assets is None

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
        FinancialsService(
            repo=repo, clock=clock, bulk=bulk, enricher=_FakeEnricher({})
        ).bulk_refresh()
        stored = repo.get("600519")
        assert stored is not None
        assert stored.net_assets == Decimal("20000")
        assert stored.net_assets_period == date(2025, 9, 30)


# ---- enrich_one ----------------------------------------------------------


class TestEnrichOne:
    def test_writes_share_counts_and_extras(self) -> None:
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
        assert svc.enrich_one("600519") is True
        stored = repo.get("600519")
        assert stored is not None
        assert stored.total_share == Decimal("2000")
        assert stored.float_share == Decimal("1500")
        assert stored.float_pct == Decimal("0.75")
        latest = stored.quarterlies[-1]
        assert latest.operating_cost == Decimal("40")
        assert latest.net_profit_excl_nr == Decimal("38")

    def test_unknown_code_returns_false(self) -> None:
        repo = _FakeRepo([])
        svc = FinancialsService(
            repo=repo,
            clock=_FixedClock(datetime(2026, 5, 1, tzinfo=UTC)),
            bulk=_FakeBulk({}),
            enricher=_FakeEnricher({}),
        )
        assert svc.enrich_one("600519") is False

    def test_no_delta_returns_false(self) -> None:
        repo = _FakeRepo([_meta()])
        svc = FinancialsService(
            repo=repo,
            clock=_FixedClock(datetime(2026, 5, 1, tzinfo=UTC)),
            bulk=_FakeBulk({}),
            enricher=_FakeEnricher({"600519": None}),
        )
        assert svc.enrich_one("600519") is False


# ---- find_stale_financials ----------------------------------------------


class TestFindStale:
    def test_lists_codes_without_watermark(self) -> None:
        a = _meta(code="000001")
        b = _meta(
            code="000002",
            financials_updated_at=datetime(2026, 5, 1, tzinfo=UTC),
        )
        repo = _FakeRepo([a, b])
        svc = FinancialsService(
            repo=repo,
            clock=_FixedClock(datetime(2026, 5, 1, tzinfo=UTC)),
            bulk=_FakeBulk({}),
            enricher=_FakeEnricher({}),
        )
        assert svc.find_stale_financials() == ["000001"]

    def test_lists_codes_older_than_max_age(self) -> None:
        old = _meta(
            code="000001",
            financials_updated_at=datetime(2026, 4, 1, tzinfo=UTC),
        )
        fresh = _meta(
            code="000002",
            financials_updated_at=datetime(2026, 4, 30, tzinfo=UTC),
        )
        repo = _FakeRepo([old, fresh])
        svc = FinancialsService(
            repo=repo,
            clock=_FixedClock(datetime(2026, 5, 1, tzinfo=UTC)),
            bulk=_FakeBulk({}),
            enricher=_FakeEnricher({}),
        )
        # Default max_age=7 days → only the 30-day-old code is stale.
        assert svc.find_stale_financials() == ["000001"]
