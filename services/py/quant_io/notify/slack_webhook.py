"""Slack incoming-webhook :class:`Notifier` (modules/08-notifications.md §3).

Posts the rendered ``(title, body)`` as a single Block Kit payload. The
webhook endpoint does not return Slack's message ``ts`` — so
``provider_msg_id`` is always ``None`` in webhook mode (doc §9). Use
``SlackBotNotifier`` if you need it.

Transport: stdlib ``urllib`` so the package picks up no new deps. The
HTTP client is dependency-injected to keep the adapter testable.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Final, Protocol
from urllib import error as urlerror
from urllib import request as urlrequest

from quant_core.config import get_settings
from quant_core.domain.types.notification import NotifierResult

if TYPE_CHECKING:
    from quant_core.domain.types.notification import Notification


_BODY_HARD_LIMIT: Final[int] = 2900  # mrkdwn section block cap is 3000.


class HttpPoster(Protocol):
    """Tiny HTTP POST port — kept local so tests can swap it out."""

    def post_json(self, url: str, payload: dict[str, object], *, timeout: float) -> int: ...


class _UrllibPoster:
    def post_json(self, url: str, payload: dict[str, object], *, timeout: float) -> int:
        data = json.dumps(payload).encode("utf-8")
        req = urlrequest.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urlrequest.urlopen(req, timeout=timeout) as resp:
                return int(resp.status)
        except urlerror.HTTPError as exc:
            return int(exc.code)


class SlackWebhookNotifier:
    """Single-channel webhook delivery."""

    __slots__ = ("_default_icon_emoji", "_default_username", "_http", "_timeout", "_url")

    name: Final[str] = "slack_webhook"

    def __init__(
        self,
        webhook_url: str,
        *,
        default_username: str | None = None,
        default_icon_emoji: str | None = None,
        http: HttpPoster | None = None,
        timeout: float | None = None,
    ) -> None:
        if not webhook_url:
            raise ValueError("SlackWebhookNotifier requires a non-empty webhook URL")
        self._url = webhook_url
        self._default_username = default_username
        self._default_icon_emoji = default_icon_emoji
        self._http = http or _UrllibPoster()
        self._timeout = timeout if timeout is not None else get_settings().slack_http_timeout_sec

    def send(self, n: Notification) -> NotifierResult:
        body = n.body if len(n.body) <= _BODY_HARD_LIMIT else n.body[:_BODY_HARD_LIMIT] + "…"
        payload: dict[str, object] = {
            "blocks": [
                {"type": "header", "text": {"type": "plain_text", "text": n.title}},
                {"type": "section", "text": {"type": "mrkdwn", "text": body}},
            ],
        }
        if self._default_username is not None:
            payload["username"] = self._default_username
        if self._default_icon_emoji is not None:
            payload["icon_emoji"] = self._default_icon_emoji

        try:
            status = self._http.post_json(self._url, payload, timeout=self._timeout)
        except (urlerror.URLError, TimeoutError) as exc:
            return NotifierResult(delivered=False, error=f"transport: {exc}")
        if 200 <= status < 300:
            return NotifierResult(delivered=True)
        return NotifierResult(delivered=False, error=f"http_{status}")
