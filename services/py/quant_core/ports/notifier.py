"""``Notifier`` domain port (modules/08-notifications.md §2)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from quant_core.domain.types.notification import Notification, NotifierResult


@runtime_checkable
class Notifier(Protocol):
    """One delivery channel (Slack webhook, Slack bot, ...)."""

    @property
    def name(self) -> str:
        """Stable identifier matched against :class:`Rule.channels`."""
        ...

    def send(self, n: Notification) -> NotifierResult:
        """Best-effort deliver. Implementations must not raise on
        provider errors — wrap them in :class:`NotifierResult.error`.
        """
        ...
