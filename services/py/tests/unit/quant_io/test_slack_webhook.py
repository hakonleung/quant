"""Unit tests for SlackWebhookNotifier."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from quant_core.domain.types.notification import Notification
from quant_io.notify.slack_webhook import SlackWebhookNotifier


class _RecordingPoster:
    def __init__(self, status: int = 200) -> None:
        self.calls: list[tuple[str, dict[str, object], float]] = []
        self._status = status

    def post_json(self, url: str, payload: dict[str, object], *, timeout: float) -> int:
        self.calls.append((url, payload, timeout))
        return self._status


def _n(body: str = "*hi*") -> Notification:
    return Notification(
        id="1",
        severity="error",
        title="hello",
        body=body,
        source="kline.sync",
        trace_id="t",
        created_at=datetime(2026, 5, 3, tzinfo=UTC),
    )


def test_send_posts_block_kit_payload() -> None:
    poster = _RecordingPoster(200)
    notifier = SlackWebhookNotifier(
        "https://hooks.example.com/x",
        default_username="quant-bot",
        default_icon_emoji=":bar_chart:",
        http=poster,
    )
    result = notifier.send(_n())
    assert result.delivered is True
    assert result.provider_msg_id is None
    assert len(poster.calls) == 1
    url, payload, _ = poster.calls[0]
    assert url == "https://hooks.example.com/x"
    blocks = payload["blocks"]
    assert isinstance(blocks, list)
    assert blocks[0]["text"]["text"] == "hello"
    assert blocks[1]["text"]["text"] == "*hi*"
    assert payload["username"] == "quant-bot"
    assert payload["icon_emoji"] == ":bar_chart:"


def test_long_body_truncated() -> None:
    poster = _RecordingPoster(200)
    notifier = SlackWebhookNotifier("https://x", http=poster)
    long_body = "a" * 4000
    notifier.send(_n(body=long_body))
    payload = poster.calls[0][1]
    section_text = payload["blocks"][1]["text"]["text"]  # type: ignore[index]
    assert len(section_text) <= 3000
    assert section_text.endswith("…")


def test_non_2xx_returns_failure() -> None:
    poster = _RecordingPoster(500)
    notifier = SlackWebhookNotifier("https://x", http=poster)
    result = notifier.send(_n())
    assert result.delivered is False
    assert result.error == "http_500"


def test_empty_url_rejected() -> None:
    with pytest.raises(ValueError, match="non-empty webhook URL"):
        SlackWebhookNotifier("")


def test_optional_username_omitted_when_unset() -> None:
    poster = _RecordingPoster(200)
    notifier = SlackWebhookNotifier("https://x", http=poster)
    notifier.send(_n())
    payload = poster.calls[0][1]
    assert "username" not in payload
    assert "icon_emoji" not in payload
