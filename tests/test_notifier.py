"""Notifier tick: end-to-end enqueue + deliver against SQLite."""

from __future__ import annotations

from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from app.config import Settings
from app.notifier import run_once
from labcore.models import NotificationOutbox, NotificationSubscription
from labcore.service import create_entity
from tests.test_notify_dispatch import StubSink


def _subscribed_person(engine: Engine, slack_id: str = "U123") -> dict:
    with Session(engine) as session:
        person = create_entity(
            session, "person", {"name": "R", "slack_id": slack_id}
        )
        session.add(
            NotificationSubscription(
                person_id=person["id"], entity_type="wafer"
            )
        )
        session.commit()
    return person


def test_run_once_delivers_matched_events(engine: Engine) -> None:
    settings = Settings()
    _subscribed_person(engine)
    sink = StubSink()
    run_once(engine, sink, settings)  # plants the cursor
    with Session(engine) as session:
        create_entity(session, "wafer", {"name": "fresh"})
        session.commit()
    enqueued, sent, dead = run_once(engine, sink, settings)
    assert (enqueued, sent, dead) == (1, 1, 0)
    assert len(sink.calls) == 1
    assert "fresh" in sink.calls[0][1]


def test_run_once_without_sink_still_matches(engine: Engine) -> None:
    settings = Settings()
    _subscribed_person(engine)
    run_once(engine, None, settings)
    with Session(engine) as session:
        create_entity(session, "wafer", {"name": "queued"})
        session.commit()
    enqueued, sent, dead = run_once(engine, None, settings)
    assert (enqueued, sent, dead) == (1, 0, 0)
    with Session(engine) as session:
        row = session.exec(select(NotificationOutbox)).one()
        assert row.status == "pending"  # waits for a token, not lost
