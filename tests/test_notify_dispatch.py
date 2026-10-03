"""Dispatcher core: matching, cursor discipline, and delivery states."""

from __future__ import annotations

from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from labcore.models import NotificationOutbox, NotificationSubscription
from labcore.notify import (
    PermanentDeliveryError,
    RetryableDeliveryError,
    deliver_pending,
    enqueue_matches,
)
from labcore.service import create_entity

PUBLIC_URL = "https://autolab.example.edu"


class StubSink:
    def __init__(self, fail: Exception | None = None) -> None:
        self.fail = fail
        self.calls: list[tuple[str, str]] = []

    def send_dm(self, slack_id: str, text: str) -> None:
        self.calls.append((slack_id, text))
        if self.fail is not None:
            raise self.fail


def _person(session: Session, slack_id: str = "U123") -> dict:
    person = create_entity(
        session, "person", {"name": "Recipient", "slack_id": slack_id}
    )
    session.commit()
    return person


def _subscribe(
    session: Session,
    person_id,
    entity_type: str = "wafer",
    action: str = "created",
    filters: dict | None = None,
) -> None:
    session.add(
        NotificationSubscription(
            person_id=person_id,
            entity_type=entity_type,
            action=action,
            filters=filters or {},
        )
    )
    session.commit()


def test_first_run_initializes_cursor_at_tail_without_backfill(
    engine: Engine,
) -> None:
    with Session(engine) as session:
        person = _person(session)
        _subscribe(session, person["id"])
        create_entity(session, "wafer", {"name": "historic"})
        session.commit()
        # First tick only plants the cursor; the historic wafer is not
        # replayed into anyone's DMs.
        assert enqueue_matches(session, PUBLIC_URL) == 0
        session.commit()
        assert enqueue_matches(session, PUBLIC_URL) == 0
        session.commit()
        create_entity(session, "wafer", {"name": "fresh"})
        session.commit()
        assert enqueue_matches(session, PUBLIC_URL) == 1
        session.commit()
        row = session.exec(select(NotificationOutbox)).one()
        assert "fresh" in row.text
        assert f"{PUBLIC_URL}/e/" in row.text


def test_matching_respects_type_action_and_filters(engine: Engine) -> None:
    with Session(engine) as session:
        person = _person(session)
        _subscribe(
            session, person["id"], filters={"material": "NbTiN"}
        )
        enqueue_matches(session, PUBLIC_URL)  # plant cursor
        session.commit()
        create_entity(session, "wafer", {"material": "Al"})
        create_entity(session, "device", {"name": "not a wafer"})
        create_entity(session, "wafer", {"material": "NbTiN", "name": "hit"})
        session.commit()
        assert enqueue_matches(session, PUBLIC_URL) == 1
        session.commit()
        assert "hit" in session.exec(select(NotificationOutbox)).one().text


def test_enqueue_is_idempotent_across_ticks(engine: Engine) -> None:
    with Session(engine) as session:
        person = _person(session)
        _subscribe(session, person["id"])
        enqueue_matches(session, PUBLIC_URL)
        session.commit()
        create_entity(session, "wafer", {"name": "once"})
        session.commit()
        assert enqueue_matches(session, PUBLIC_URL) == 1
        session.commit()
        assert enqueue_matches(session, PUBLIC_URL) == 0
        session.commit()
        assert len(session.exec(select(NotificationOutbox)).all()) == 1


def test_delivery_success_marks_sent(engine: Engine) -> None:
    with Session(engine) as session:
        person = _person(session)
        session.add(NotificationOutbox(person_id=person["id"], text="hello"))
        session.commit()
        sink = StubSink()
        assert deliver_pending(session, sink) == (1, 0)
        session.commit()
        row = session.exec(select(NotificationOutbox)).one()
        assert row.status == "sent"
        assert row.sent_at is not None
        assert sink.calls == [("U123", "hello")]
        # Sent rows are not redelivered.
        assert deliver_pending(session, sink) == (0, 0)
        assert len(sink.calls) == 1


def test_retryable_failure_retries_then_dead_letters(engine: Engine) -> None:
    with Session(engine) as session:
        person = _person(session)
        session.add(NotificationOutbox(person_id=person["id"], text="hi"))
        session.commit()
        sink = StubSink(fail=RetryableDeliveryError("rate limited"))
        assert deliver_pending(session, sink, max_attempts=3) == (0, 0)
        assert deliver_pending(session, sink, max_attempts=3) == (0, 0)
        assert deliver_pending(session, sink, max_attempts=3) == (0, 1)
        session.commit()
        row = session.exec(select(NotificationOutbox)).one()
        assert row.status == "dead"
        assert row.attempts == 3
        assert "rate limited" in row.last_error


def test_permanent_failure_dead_letters_immediately(engine: Engine) -> None:
    with Session(engine) as session:
        person = _person(session)
        session.add(NotificationOutbox(person_id=person["id"], text="hi"))
        session.commit()
        sink = StubSink(fail=PermanentDeliveryError("user_not_found"))
        assert deliver_pending(session, sink) == (0, 1)
        row = session.exec(select(NotificationOutbox)).one()
        assert row.status == "dead"
        assert len(sink.calls) == 1


def test_missing_slack_id_dead_letters_without_sink_call(
    engine: Engine,
) -> None:
    with Session(engine) as session:
        person = _person(session, slack_id="")
        session.add(NotificationOutbox(person_id=person["id"], text="hi"))
        session.commit()
        sink = StubSink()
        assert deliver_pending(session, sink) == (0, 1)
        row = session.exec(select(NotificationOutbox)).one()
        assert "no slack_id" in row.last_error
        assert sink.calls == []


def test_one_bad_recipient_does_not_block_others(engine: Engine) -> None:
    with Session(engine) as session:
        good = _person(session)
        bad = create_entity(session, "person", {"name": "No Slack"})
        session.add(NotificationOutbox(person_id=bad["id"], text="a"))
        session.add(NotificationOutbox(person_id=good["id"], text="b"))
        session.commit()
        sink = StubSink()
        assert deliver_pending(session, sink) == (1, 1)
        assert sink.calls == [("U123", "b")]
