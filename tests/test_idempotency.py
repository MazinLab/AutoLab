import pytest
from sqlmodel import Session

from labcore.events import list_events
from labcore.models.base import utcnow
from labcore.service import create_entity


def test_source_key_replay_returns_original_without_new_event(
    session: Session,
) -> None:
    first = create_entity(
        session,
        "measurement_run",
        {"name": "sweep 1"},
        source_key="operation:abc",
    )
    replay = create_entity(
        session,
        "measurement_run",
        {"name": "ignored replay payload"},
        source_key="operation:abc",
    )

    assert replay == first
    created = [
        event
        for event in list_events(session, limit=1000)
        if event["action"] == "created"
        and event["entity_id"] == first["id"]
    ]
    assert len(created) == 1


def test_source_key_replay_unwinds_accession_increment(
    session: Session,
) -> None:
    year = utcnow().year
    first = create_entity(
        session, "wafer", {"name": "W1"}, source_key="operation:abc"
    )
    create_entity(
        session, "wafer", {"name": "replay"}, source_key="operation:abc"
    )
    second = create_entity(session, "wafer", {"name": "W2"})

    assert first["accession"] == f"W-{year}-0001"
    assert second["accession"] == f"W-{year}-0002"


def test_source_key_replay_rejects_conflicting_entity_type(
    session: Session,
) -> None:
    create_entity(
        session,
        "measurement_run",
        {"name": "sweep 1"},
        source_key="operation:abc",
    )

    with pytest.raises(ValueError, match="belongs to measurement_run"):
        create_entity(
            session,
            "wafer",
            {"name": "W1"},
            source_key="operation:abc",
        )
