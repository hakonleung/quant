"""Integration tests for NotificationService (modules/08 §8.2)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import pytest
from quant_cache.file_kv_store import FileKeyValueStore
from quant_core.domain.types.notification import (
    Notification,
    NotifierResult,
    Rule,
)
from quant_core.services.notification_service import NotificationService

from tests._util.clock import FrozenClock

if TYPE_CHECKING:
    from pathlib import Path


class _FakeNotifier:
    name = "slack_webhook"

    def __init__(
        self,
        *,
        result: NotifierResult | None = None,
        raise_exc: Exception | None = None,
    ) -> None:
        self._result = result or NotifierResult(delivered=True)
        self._raise = raise_exc
        self.sent: list[Notification] = []

    def send(self, n: Notification) -> NotifierResult:
        if self._raise is not None:
            raise self._raise
        self.sent.append(n)
        return self._result


def _make_n(
    *,
    nid: str = "id-1",
    source: str = "kline.sync",
    severity: str = "error",
    trace_id: str = "tr-1",
    created_at: datetime | None = None,
    dedupe_key: str | None = None,
    related_codes: tuple[str, ...] = (),
) -> Notification:
    return Notification(
        id=nid,
        severity=severity,  # type: ignore[arg-type]
        title="K-line sync failed",
        body="*details*",
        source=source,
        trace_id=trace_id,
        created_at=created_at or datetime(2026, 5, 3, 12, 0, tzinfo=UTC),
        related_codes=related_codes,
        dedupe_key=dedupe_key,
    )


@pytest.fixture
def kv(tmp_path: Path) -> FileKeyValueStore:
    return FileKeyValueStore(
        root=tmp_path / "kv",
        clock=FrozenClock(datetime(2026, 5, 3, 12, 0, tzinfo=UTC)),
    )


def _build_service(
    tmp_path: Path,
    *,
    channels: dict[str, _FakeNotifier],
    rules: list[Rule],
    rate_limits_per_min: dict[str, int] | None = None,
    clock: FrozenClock | None = None,
) -> tuple[NotificationService, FrozenClock]:
    use_clock = clock or FrozenClock(datetime(2026, 5, 3, 12, 0, tzinfo=UTC))
    kv = FileKeyValueStore(root=tmp_path / "kv", clock=use_clock)
    svc = NotificationService(
        channels=channels,
        rules=rules,
        dedupe=kv,
        clock=use_clock,
        audit_dir=tmp_path / "audit",
        rate_limits_per_min=rate_limits_per_min,
    )
    return svc, use_clock


def test_route_match_delivers(tmp_path: Path) -> None:
    notifier = _FakeNotifier(result=NotifierResult(delivered=True, provider_msg_id="ts1"))
    svc, _ = _build_service(
        tmp_path,
        channels={"slack_webhook": notifier},
        rules=[Rule(source="kline.sync", severity_in=("error",), channels=("slack_webhook",))],
    )
    out = svc.emit(_make_n())
    assert len(notifier.sent) == 1
    assert out.deliveries[0].outcome == "delivered"
    assert out.deliveries[0].provider_msg_id == "ts1"


def test_dedupe_within_window(tmp_path: Path) -> None:
    notifier = _FakeNotifier()
    svc, _ = _build_service(
        tmp_path,
        channels={"slack_webhook": notifier},
        rules=[
            Rule(
                source="kline.sync",
                severity_in=("error",),
                channels=("slack_webhook",),
                dedupe_window_min=30,
            )
        ],
    )
    n = _make_n()
    first = svc.emit(n)
    second = svc.emit(_make_n(nid="id-2"))  # same date → same default key
    assert first.deliveries[0].outcome == "delivered"
    assert second.deliveries[0].outcome == "deduped"
    assert len(notifier.sent) == 1


def test_dedupe_window_expires(tmp_path: Path) -> None:
    notifier = _FakeNotifier()
    clock = FrozenClock(datetime(2026, 5, 3, 12, 0, tzinfo=UTC))
    svc, _ = _build_service(
        tmp_path,
        channels={"slack_webhook": notifier},
        rules=[
            Rule(
                source="custom",
                severity_in=("info",),
                channels=("slack_webhook",),
                dedupe_window_min=1,
            )
        ],
        clock=clock,
    )
    svc.emit(_make_n(source="custom", severity="info", dedupe_key="k"))
    clock.advance(seconds=61)
    out = svc.emit(_make_n(source="custom", severity="info", dedupe_key="k"))
    assert out.deliveries[0].outcome == "delivered"
    assert len(notifier.sent) == 2


def test_rate_limit_drops_when_exhausted(tmp_path: Path) -> None:
    notifier = _FakeNotifier()
    svc, _ = _build_service(
        tmp_path,
        channels={"slack_webhook": notifier},
        rules=[
            Rule(
                source="custom",
                severity_in=("info",),
                channels=("slack_webhook",),
                dedupe_window_min=0,  # immediate re-emit
            )
        ],
        rate_limits_per_min={"slack_webhook": 1},
    )
    # First passes, second drops (different dedupe keys).
    o1 = svc.emit(_make_n(source="custom", severity="info", dedupe_key="a"))
    o2 = svc.emit(_make_n(source="custom", severity="info", dedupe_key="b"))
    assert o1.deliveries[0].outcome == "delivered"
    assert o2.deliveries[0].outcome == "rate_limited_dropped"


def test_no_matching_rule_drops_with_audit(tmp_path: Path) -> None:
    notifier = _FakeNotifier()
    svc, _ = _build_service(
        tmp_path,
        channels={"slack_webhook": notifier},
        rules=[Rule(source="kline.sync", severity_in=("error",), channels=("slack_webhook",))],
    )
    out = svc.emit(_make_n(source="other"))
    assert out.deliveries[0].outcome == "dropped"
    assert out.deliveries[0].error == "no_matching_rule"
    audit_files = list((tmp_path / "audit").glob("*.jsonl"))
    assert audit_files
    record = json.loads(audit_files[0].read_text().strip().splitlines()[0])
    assert record["outcome"] == "dropped"
    assert record["channel"] == "_no_match"


def test_unknown_channel_drops(tmp_path: Path) -> None:
    svc, _ = _build_service(
        tmp_path,
        channels={},
        rules=[Rule(source="kline.sync", severity_in=("error",), channels=("ghost",))],
    )
    out = svc.emit(_make_n())
    assert out.deliveries[0].outcome == "dropped"
    assert out.deliveries[0].error == "unknown_channel"


def test_notifier_failure_recorded(tmp_path: Path) -> None:
    notifier = _FakeNotifier(result=NotifierResult(delivered=False, error="http_500"))
    svc, _ = _build_service(
        tmp_path,
        channels={"slack_webhook": notifier},
        rules=[Rule(source="kline.sync", severity_in=("error",), channels=("slack_webhook",))],
    )
    out = svc.emit(_make_n())
    assert out.deliveries[0].outcome == "failed"
    assert out.deliveries[0].error == "http_500"


def test_notifier_exception_caught(tmp_path: Path) -> None:
    notifier = _FakeNotifier(raise_exc=RuntimeError("boom"))
    svc, _ = _build_service(
        tmp_path,
        channels={"slack_webhook": notifier},
        rules=[Rule(source="kline.sync", severity_in=("error",), channels=("slack_webhook",))],
    )
    out = svc.emit(_make_n())
    assert out.deliveries[0].outcome == "failed"
    assert "boom" in (out.deliveries[0].error or "")


def test_audit_log_records_delivery(tmp_path: Path) -> None:
    notifier = _FakeNotifier(result=NotifierResult(delivered=True, provider_msg_id="ts1"))
    svc, _ = _build_service(
        tmp_path,
        channels={"slack_webhook": notifier},
        rules=[Rule(source="kline.sync", severity_in=("error",), channels=("slack_webhook",))],
    )
    svc.emit(_make_n())
    audit_files = list((tmp_path / "audit").glob("*.jsonl"))
    assert len(audit_files) == 1
    rec = json.loads(audit_files[0].read_text().strip())
    assert rec["outcome"] == "delivered"
    assert rec["provider_msg_id"] == "ts1"
    assert rec["trace_id"] == "tr-1"
