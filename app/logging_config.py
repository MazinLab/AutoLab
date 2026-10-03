from __future__ import annotations

import json
import logging
from datetime import datetime, timezone


_HANDLER_NAME = "autolab"
_PLAIN_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.fromtimestamp(
                record.created, tz=timezone.utc
            ).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def setup_logging(json_logs: bool) -> None:
    root_logger = logging.getLogger()
    handler = next(
        (
            existing
            for existing in root_logger.handlers
            if existing.get_name() == _HANDLER_NAME
        ),
        None,
    )
    if handler is None:
        handler = logging.StreamHandler()
        handler.set_name(_HANDLER_NAME)
        root_logger.addHandler(handler)

    formatter: logging.Formatter
    if json_logs:
        formatter = JsonFormatter()
    else:
        formatter = logging.Formatter(_PLAIN_FORMAT)
    handler.setFormatter(formatter)
    root_logger.setLevel(logging.INFO)
