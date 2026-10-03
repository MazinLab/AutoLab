import uuid
from datetime import UTC, datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.api.lineage import _decode_cursor


def test_entity_events_reject_naive_cursor_timestamp(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()
    cursor = f"2026-07-19T12:00:00|{uuid.uuid4()}"

    response = client.get(
        f"/api/entities/{wafer['id']}/events",
        params={"after": cursor},
    )

    assert response.status_code == 422
    assert response.json()["detail"].startswith(
        "cursor timestamp must include a UTC offset"
    )


def test_entity_events_cursor_timestamp_is_normalized_to_utc() -> None:
    event_id = uuid.uuid4()
    cursor = f"2026-07-19T05:00:00-07:00|{event_id}"

    at, decoded_event_id = _decode_cursor(cursor)

    assert at == datetime(2026, 7, 19, 12, tzinfo=UTC)
    assert at.tzinfo is UTC
    assert decoded_event_id == event_id


def test_entity_events_accept_zero_offset_spelled_with_z() -> None:
    event_id = uuid.uuid4()

    at, decoded_event_id = _decode_cursor(f"2026-07-19T12:00:00Z|{event_id}")

    assert at == datetime(2026, 7, 19, 12, tzinfo=UTC)
    assert decoded_event_id == event_id


def test_entity_events_accept_nonzero_utc_offset(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()
    first_page = client.get(
        f"/api/entities/{wafer['id']}/events",
        params={"limit": 1},
    ).json()
    at_raw, event_id = first_page["next_cursor"].split("|", 1)
    pacific = timezone(timedelta(hours=-7))
    equivalent_at = datetime.fromisoformat(at_raw).astimezone(pacific)

    response = client.get(
        f"/api/entities/{wafer['id']}/events",
        params={"after": f"{equivalent_at.isoformat()}|{event_id}"},
    )

    assert response.status_code == 200
    assert response.json() == {"events": [], "next_cursor": None}


def test_entity_events_returns_404_for_missing_entity(client: TestClient) -> None:
    response = client.get(f"/api/entities/{uuid.UUID(int=0)}/events")

    assert response.status_code == 404
    assert response.json() == {"detail": "entity not found"}
