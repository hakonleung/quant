"""Notification orchestration (modules/08-notifications.md §5).

Routes a :class:`Notification` through a configurable rule table,
deduplicates within a configurable window via a
:class:`KeyValueStore`, applies a per-channel token-bucket rate
limit, and finally delegates delivery to the registered
:class:`Notifier`. Every attempt is appended to a daily
``data/_audit/notifications/<date>.jsonl`` log.

The service intentionally does not produce events — it only consumes
them. Sources include the K-line sync workers, LLM clients, and the
(v2) user-subscribed screen-alert dispatcher.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from quant_core.domain.pure.notification_route import default_dedupe_key, match_rule
from quant_core.domain.types.notification import (
    Delivery,
    NotificationOutcome,
)

if TYPE_CHECKING:
    from collections.abc import Mapping
    from datetime import datetime
    from pathlib import Path

    from quant_core.domain.types.notification import (
        Notification,
        Rule,
    )
    from quant_core.ports.cache import KeyValueStore
    from quant_core.ports.clock import Clock
    from quant_core.ports.notifier import Notifier


logger = logging.getLogger(__name__)


@dataclass
class _Bucket:
    """Per-channel token bucket (one minute window).

    Stored as ``tokens`` (float) and ``last_refill`` (UTC datetime). Not
    thread-safe — caller serialises access via the service.
    """

    capacity: int
    refill_per_min: float
    tokens: float
    last_refill: datetime


class _RateLimiter:
    __slots__ = ("_buckets", "_clock")

    def __init__(self, clock: Clock, limits: Mapping[str, int]) -> None:
        self._clock = clock
        now = clock.now()
        self._buckets: dict[str, _Bucket] = {
            name: _Bucket(
                capacity=cap,
                refill_per_min=float(cap),
                tokens=float(cap),
                last_refill=now,
            )
            for name, cap in limits.items()
        }

    def try_take(self, name: str) -> bool:
        bucket = self._buckets.get(name)
        if bucket is None:
            # No configured limit → unlimited.
            return True
        now = self._clock.now()
        elapsed = (now - bucket.last_refill).total_seconds()
        if elapsed > 0:
            bucket.tokens = min(
                float(bucket.capacity),
                bucket.tokens + elapsed * (bucket.refill_per_min / 60.0),
            )
            bucket.last_refill = now
        if bucket.tokens >= 1.0:
            bucket.tokens -= 1.0
            return True
        return False


class NotificationService:
    """Route + dedupe + rate-limit + deliver + audit."""

    __slots__ = ("_audit_dir", "_channels", "_clock", "_dedupe", "_limiter", "_rules")

    def __init__(
        self,
        *,
        channels: Mapping[str, Notifier],
        rules: list[Rule],
        dedupe: KeyValueStore,
        clock: Clock,
        audit_dir: Path,
        rate_limits_per_min: Mapping[str, int] | None = None,
    ) -> None:
        self._channels = dict(channels)
        self._rules = list(rules)
        self._dedupe = dedupe
        self._clock = clock
        self._audit_dir = audit_dir
        self._limiter = _RateLimiter(clock, rate_limits_per_min or {})

    def emit(self, n: Notification) -> NotificationOutcome:
        rule = match_rule(self._rules, n)
        if rule is None:
            self._audit(n, "_no_match", "dropped", error="no_matching_rule")
            return NotificationOutcome(
                notification_id=n.id,
                deliveries=(
                    Delivery(channel="_no_match", outcome="dropped", error="no_matching_rule"),
                ),
            )

        deliveries: list[Delivery] = []
        for channel_name in rule.channels:
            deliveries.append(self._deliver_one(n, rule, channel_name))
        return NotificationOutcome(notification_id=n.id, deliveries=tuple(deliveries))

    def _deliver_one(self, n: Notification, rule: Rule, channel_name: str) -> Delivery:
        notifier = self._channels.get(channel_name)
        if notifier is None:
            self._audit(n, channel_name, "dropped", error="unknown_channel")
            return Delivery(channel=channel_name, outcome="dropped", error="unknown_channel")

        # Dedupe — keyed per (channel, dedupe_key) so the same event can
        # still hit multiple channels but won't repeat on one channel.
        dedupe_key = default_dedupe_key(n)
        cache_key = f"notify:{channel_name}:{dedupe_key}"
        if self._dedupe.get(cache_key) is not None:
            self._audit(n, channel_name, "deduped")
            return Delivery(channel=channel_name, outcome="deduped")

        if not self._limiter.try_take(channel_name):
            self._audit(n, channel_name, "rate_limited_dropped")
            return Delivery(channel=channel_name, outcome="rate_limited_dropped")

        try:
            result = notifier.send(n)
        except Exception as exc:
            logger.exception("notifier_send_crashed", extra={"channel": channel_name})
            self._audit(n, channel_name, "failed", error=str(exc))
            return Delivery(channel=channel_name, outcome="failed", error=str(exc))

        if not result.delivered:
            self._audit(n, channel_name, "failed", error=result.error)
            return Delivery(
                channel=channel_name,
                outcome="failed",
                error=result.error,
            )

        if rule.dedupe_window_min > 0:
            self._dedupe.put(cache_key, b"1", ttl_sec=rule.dedupe_window_min * 60)
        self._audit(
            n,
            channel_name,
            "delivered",
            provider_msg_id=result.provider_msg_id,
        )
        return Delivery(
            channel=channel_name,
            outcome="delivered",
            provider_msg_id=result.provider_msg_id,
        )

    def _audit(
        self,
        n: Notification,
        channel: str,
        outcome: str,
        *,
        provider_msg_id: str | None = None,
        error: str | None = None,
    ) -> None:
        now = self._clock.now()
        record = {
            "id": n.id,
            "source": n.source,
            "severity": n.severity,
            "channel": channel,
            "outcome": outcome,
            "provider_msg_id": provider_msg_id,
            "error": error,
            "trace_id": n.trace_id,
            "ts": now.isoformat(),
        }
        target = self._audit_dir / f"{now.date().isoformat()}.jsonl"
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
