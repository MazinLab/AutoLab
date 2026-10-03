from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from labcore.models.events import Event
from labcore.service import create_entity


def test_event_fresh_session_load_preserves_utc(engine: Engine) -> None:
    with Session(engine) as session:
        create_entity(session, "wafer", {"name": "W1"})
        session.commit()

    with Session(engine) as fresh_session:
        event = fresh_session.exec(select(Event)).one()

    assert event.at.tzinfo == UTC


def test_events_cursor_round_trips_aware_timestamp(client: TestClient) -> None:
    for index in range(2):
        response = client.post("/api/wafer", json={"name": f"W{index}"})
        assert response.status_code == 201

    first_page = client.get("/api/events", params={"limit": 1})
    assert first_page.status_code == 200
    first_body = first_page.json()
    cursor = first_body["next_cursor"]
    assert cursor is not None

    event_at = datetime.fromisoformat(first_body["events"][0]["at"])
    cursor_at_raw, cursor_id = cursor.split("|", 1)
    cursor_at = datetime.fromisoformat(cursor_at_raw)
    assert event_at.tzinfo == UTC
    assert cursor_at.tzinfo == UTC
    assert cursor_at == event_at
    assert cursor_id == first_body["events"][0]["id"]

    second_page = client.get("/api/events", params={"after": cursor, "limit": 1})
    assert second_page.status_code == 200
    second_body = second_page.json()
    assert len(second_body["events"]) == 1
    assert second_body["events"][0]["id"] != first_body["events"][0]["id"]
    assert datetime.fromisoformat(second_body["events"][0]["at"]).tzinfo == UTC
