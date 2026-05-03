"""Notification domain types (modules/08-notifications.md §2).

Frozen dataclasses for the ingest / route / deliver pipeline. Lives in
``domain/types`` so adapters and services share one source of truth.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from datetime import datetime


Severity = Literal["info", "warn", "error", "fatal"]
"""Standard severity levels — must match docs/modules/08 §2."""

DeliveryOutcome = Literal[
    "delivered",
    "deduped",
    "rate_limited_dropped",
    "failed",
    "dropped",
]


@dataclass(frozen=True, slots=True)
class Notification:
    """One pending notification — content + provenance.

    ``dedupe_key`` overrides the default ``(source, ...)`` key (see
    :func:`quant_core.domain.pure.notification_route.default_dedupe_key`).
    """

    id: str
    severity: Severity
    title: str
    body: str
    source: str
    trace_id: str
    created_at: datetime
    related_codes: tuple[str, ...] = ()
    dedupe_key: str | None = None


@dataclass(frozen=True, slots=True)
class NotifierResult:
    """Outcome of a single channel ``send`` attempt."""

    delivered: bool
    provider_msg_id: str | None = None
    error: str | None = None


@dataclass(frozen=True, slots=True)
class Rule:
    """One row of the route table (modules/08 §4.1)."""

    source: str
    severity_in: tuple[Severity, ...]
    channels: tuple[str, ...]
    dedupe_window_min: int = 30
    slack_channel_override: str | None = None


@dataclass(frozen=True, slots=True)
class Delivery:
    """Per-channel delivery record (one element of NotificationOutcome)."""

    channel: str
    outcome: DeliveryOutcome
    provider_msg_id: str | None = None
    error: str | None = None


@dataclass(frozen=True, slots=True)
class NotificationOutcome:
    """Result returned from :meth:`NotificationService.emit`."""

    notification_id: str
    deliveries: tuple[Delivery, ...] = field(default_factory=tuple)
