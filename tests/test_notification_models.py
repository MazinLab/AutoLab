"""Notification tables: cascades and datetime discipline."""

from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from labcore.models import NotificationOutbox, NotificationSubscription
from labcore.service import create_entity, delete_entity


def _person(session: Session) -> dict:
    person = create_entity(session, "person", {"name": "Recipient"})
    session.commit()
    return person


def test_deleting_a_person_cascades_notification_rows(engine: Engine) -> None:
    with Session(engine) as session:
        person = _person(session)
        actor = create_entity(session, "person", {"name": "Actor"})
        session.add(
            NotificationSubscription(
                person_id=person["id"], entity_type="wafer"
            )
        )
        session.add(NotificationOutbox(person_id=person["id"], text="hi"))
        session.commit()
        delete_entity(session, person["id"], actor_id=actor["id"])
        session.commit()
        assert session.exec(select(NotificationSubscription)).all() == []
        assert session.exec(select(NotificationOutbox)).all() == []


def test_naive_datetime_rejected(engine: Engine) -> None:
    with Session(engine) as session:
        person = _person(session)
        session.add(
            NotificationOutbox(
                person_id=person["id"],
                text="hi",
                created_at=datetime(2026, 8, 8),
            )
        )
        with pytest.raises(Exception, match="naive datetime"):
            session.commit()
