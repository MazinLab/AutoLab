from __future__ import annotations

import json
import logging
import sys

from app.logging_config import JsonFormatter, setup_logging


def test_json_formatter_emits_fixed_schema() -> None:
    record = logging.LogRecord(
        name="autolab.test",
        level=logging.WARNING,
        pathname=__file__,
        lineno=1,
        msg="cooldown %s stalled",
        args=("CD-7",),
        exc_info=None,
    )

    payload = json.loads(JsonFormatter().format(record))

    assert set(payload) == {"timestamp", "level", "logger", "message"}
    assert payload["timestamp"].endswith("+00:00")
    assert payload["level"] == "WARNING"
    assert payload["logger"] == "autolab.test"
    assert payload["message"] == "cooldown CD-7 stalled"


def test_json_formatter_serializes_exception() -> None:
    try:
        raise ValueError("boom")
    except ValueError:
        exc_info = sys.exc_info()
    record = logging.LogRecord(
        name="autolab.test",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg="failed",
        args=(),
        exc_info=exc_info,
    )

    payload = json.loads(JsonFormatter().format(record))

    assert "ValueError: boom" in payload["exception"]


def test_setup_logging_is_idempotent() -> None:
    root_logger = logging.getLogger()

    setup_logging(json_logs=True)
    handlers = [
        handler
        for handler in root_logger.handlers
        if handler.get_name() == "autolab"
    ]
    assert len(handlers) == 1
    assert isinstance(handlers[0].formatter, JsonFormatter)

    setup_logging(json_logs=False)
    repeated_handlers = [
        handler
        for handler in root_logger.handlers
        if handler.get_name() == "autolab"
    ]

    assert repeated_handlers == handlers
    assert not isinstance(repeated_handlers[0].formatter, JsonFormatter)
