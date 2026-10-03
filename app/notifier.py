"""Notification dispatcher loop: match feed events, deliver Slack DMs.

Run as ``python -m app.notifier``. Without a bot token, matching still runs
(the outbox accumulates) and delivery waits — so the service can deploy
before the Slack app exists.
"""

from __future__ import annotations

import logging
import signal
import time

from sqlmodel import Session

from app.config import Settings
from app.slack_sink import SlackSink
from labcore.db import make_engine
from labcore.notify import NotificationSink, deliver_pending, enqueue_matches

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 30.0


def run_once(
    engine, sink: NotificationSink | None, settings: Settings
) -> tuple[int, int, int]:
    """One tick: enqueue matches, then deliver. Returns (enqueued, sent, dead)."""
    with Session(engine) as session:
        enqueued = enqueue_matches(session, settings.public_base_url)
        session.commit()
    sent = dead = 0
    if sink is not None:
        with Session(engine) as session:
            sent, dead = deliver_pending(session, sink)
            session.commit()
    return enqueued, sent, dead


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    settings = Settings()
    engine = make_engine(settings.db_url)
    sink: NotificationSink | None = None
    if settings.slack_bot_token:
        sink = SlackSink(settings.slack_bot_token)
    else:
        logger.warning(
            "AUTOLAB_SLACK_BOT_TOKEN not set: matching runs, delivery waits"
        )

    stopping = False

    def _stop(signum: int, frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    while not stopping:
        try:
            enqueued, sent, dead = run_once(engine, sink, settings)
            if enqueued or sent or dead:
                logger.info(
                    "tick: %d enqueued, %d sent, %d dead",
                    enqueued,
                    sent,
                    dead,
                )
        except Exception:
            # A bad tick (DB hiccup, Slack outage surfacing unexpectedly)
            # must not kill the loop; the cursor/outbox make retry safe.
            logger.exception("notifier tick failed")
        deadline = time.monotonic() + INTERVAL_SECONDS
        while not stopping and time.monotonic() < deadline:
            time.sleep(0.5)


if __name__ == "__main__":
    main()
