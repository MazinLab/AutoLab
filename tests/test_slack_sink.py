"""Slack sink error taxonomy over a mock transport — no network ever."""

from __future__ import annotations

import json

import httpx
import pytest

from app.slack_sink import SlackSink
from labcore.notify import PermanentDeliveryError, RetryableDeliveryError


def _sink(handler) -> SlackSink:
    client = httpx.Client(
        transport=httpx.MockTransport(handler),
        base_url="https://slack.com/api",
    )
    return SlackSink("xoxb-test", client=client)


def test_send_dm_opens_conversation_then_posts_and_caches_channel() -> None:
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        calls.append({"path": request.url.path, **payload})
        if request.url.path.endswith("conversations.open"):
            return httpx.Response(
                200, json={"ok": True, "channel": {"id": "D999"}}
            )
        return httpx.Response(200, json={"ok": True})

    sink = _sink(handler)
    sink.send_dm("U123", "first")
    sink.send_dm("U123", "second")

    opens = [c for c in calls if c["path"].endswith("conversations.open")]
    posts = [c for c in calls if c["path"].endswith("chat.postMessage")]
    assert len(opens) == 1  # second DM reuses the cached channel
    assert [p["text"] for p in posts] == ["first", "second"]
    assert all(p["channel"] == "D999" for p in posts)


def test_rate_limit_is_retryable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"ok": False, "error": "ratelimited"})

    with pytest.raises(RetryableDeliveryError, match="429"):
        _sink(handler).send_dm("U123", "hi")


def test_unknown_user_is_permanent() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"ok": False, "error": "user_not_found"}
        )

    with pytest.raises(PermanentDeliveryError, match="user_not_found"):
        _sink(handler).send_dm("U404", "hi")


def test_network_error_is_retryable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    with pytest.raises(RetryableDeliveryError, match="transport"):
        _sink(handler).send_dm("U123", "hi")


def test_empty_token_refused() -> None:
    with pytest.raises(ValueError, match="bot token"):
        SlackSink("")
