"""Slack DM delivery sink for the notification outbox."""

from __future__ import annotations

import logging

import httpx

from labcore.notify import PermanentDeliveryError, RetryableDeliveryError

logger = logging.getLogger(__name__)

_SLACK_API = "https://slack.com/api"
# Slack "ok": false errors that no retry will ever fix.
_PERMANENT_ERRORS = {
    "user_not_found",
    "users_not_found",
    "users_not_visible",
    "channel_not_found",
    "is_archived",
    "invalid_auth",
    "account_inactive",
    "token_revoked",
    "msg_too_long",
}


class SlackSink:
    """DMs via a bot token: conversations.open once per user, then post."""

    def __init__(
        self, token: str, client: httpx.Client | None = None
    ) -> None:
        if not token:
            raise ValueError("SlackSink requires a bot token")
        self._client = client or httpx.Client(
            base_url=_SLACK_API,
            headers={"Authorization": f"Bearer {token}"},
            timeout=10.0,
        )
        self._channel_cache: dict[str, str] = {}

    def _call(self, method: str, payload: dict) -> dict:
        try:
            response = self._client.post(f"/{method}", json=payload)
        except httpx.HTTPError as error:
            raise RetryableDeliveryError(f"slack transport: {error}") from error
        if response.status_code == 429 or response.status_code >= 500:
            raise RetryableDeliveryError(
                f"slack HTTP {response.status_code} on {method}"
            )
        body = response.json()
        if not body.get("ok", False):
            error = str(body.get("error", "unknown_error"))
            if error in _PERMANENT_ERRORS:
                raise PermanentDeliveryError(f"slack {method}: {error}")
            raise RetryableDeliveryError(f"slack {method}: {error}")
        return body

    def _dm_channel(self, slack_id: str) -> str:
        cached = self._channel_cache.get(slack_id)
        if cached is not None:
            return cached
        body = self._call("conversations.open", {"users": slack_id})
        channel = str(body["channel"]["id"])
        self._channel_cache[slack_id] = channel
        return channel

    def send_dm(self, slack_id: str, text: str) -> None:
        channel = self._dm_channel(slack_id)
        self._call("chat.postMessage", {"channel": channel, "text": text})
