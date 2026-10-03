import uuid

from sqlmodel import Session

from labcore.events import list_events, record_event
from labcore.lineage import add_edge
from labcore.models.edges import RelationType
from labcore.service import create_entity, get_entity, update_entity


def test_create_update_link_all_write_events(session: Session) -> None:
    agent = create_entity(session, "agent", {"name": "fable"})
    wafer = create_entity(
        session, "wafer", {"name": "W1"}, actor_id=agent["id"]
    )
    device = create_entity(session, "device", {"name": "D1"})
    update_entity(session, wafer["id"], {"material": "Nb"},
                  actor_id=agent["id"])
    add_edge(session, device["id"], RelationType.DERIVED_FROM, wafer["id"],
             actor_id=agent["id"])
    events = list_events(session)
    actions = [e["action"] for e in events]
    assert actions.count("created") == 3
    assert actions.count("updated") == 1
    assert actions.count("linked") == 1


def test_events_carry_actor_and_payload(session: Session) -> None:
    agent = create_entity(session, "agent", {"name": "fable"})
    wafer = create_entity(
        session, "wafer", {"name": "W1"}, actor_id=agent["id"]
    )
    created = [e for e in list_events(session)
               if e["action"] == "created" and e["entity_id"] == wafer["id"]]
    assert len(created) == 1
    assert created[0]["actor_id"] == agent["id"]
    assert created[0]["payload"]["entity_type"] == "wafer"


def test_event_payload_preserves_json_shape_and_stringifies_top_level_values(
    session: Session,
) -> None:
    wafer = create_entity(session, "wafer", {"name": "W1"})
    token = uuid.uuid4()
    record_event(
        session,
        "annotated",
        wafer["id"],
        payload={"nested": {"values": [1, None, True]}, "token": token},
    )
    session.flush()

    annotated = [
        event for event in list_events(session) if event["action"] == "annotated"
    ]
    assert len(annotated) == 1
    assert annotated[0]["payload"] == {
        "nested": {"values": [1, None, True]},
        "token": str(token),
    }


def test_entity_and_event_rollback_together(session: Session) -> None:
    wafer = create_entity(session, "wafer", {"name": "W1"})
    session.rollback()

    assert get_entity(session, wafer["id"]) is None
    assert list_events(session) == []


def test_cursor_pagination_never_repeats_or_skips(session: Session) -> None:
    for i in range(5):
        create_entity(session, "wafer", {"name": f"W{i}"})
    seen: list = []
    cursor = None
    while True:
        page = list_events(session, after=cursor, limit=2)
        if not page:
            break
        seen.extend(e["id"] for e in page)
        cursor = (page[-1]["at"], page[-1]["id"])
    assert len(seen) == 5
    assert len(set(seen)) == 5  # strict (at, id) cursor: no repeats, no skips
