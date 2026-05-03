"""Pure helpers for notification routing / dedupe (modules/08 §4)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from quant_core.domain.types.notification import Notification, Rule


def match_rule(rules: list[Rule], n: Notification) -> Rule | None:
    """Return the first rule whose ``source`` and ``severity_in`` match.

    Routing is "first match wins" per doc §4.1 — order in the rules list
    is meaningful. ``None`` means the notification is dropped.
    """
    for rule in rules:
        if rule.source == n.source and n.severity in rule.severity_in:
            return rule
    return None


def default_dedupe_key(n: Notification) -> str:
    """Source-aware default dedupe key (modules/08 §4.3).

    Callers may override by setting ``Notification.dedupe_key``; this
    function only computes the fallback when ``dedupe_key is None``.
    """
    if n.dedupe_key is not None:
        return n.dedupe_key
    if n.source == "kline.sync":
        return f"{n.source}:{n.created_at.date().isoformat()}"
    if n.source == "screen.alert":
        codes = ",".join(sorted(n.related_codes))
        return f"{n.source}:{codes}"
    # Generic default: source + trace_id (per-incident).
    return f"{n.source}:{n.trace_id}"
