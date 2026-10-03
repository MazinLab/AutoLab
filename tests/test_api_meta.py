from fastapi.testclient import TestClient

# the shared `client` fixture comes from tests/conftest.py


def test_events_feed_returns_writes(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()
    body = client.get("/api/events").json()
    assert any(
        e["action"] == "created" and e["entity_id"] == wafer["id"]
        for e in body["events"]
    )


def test_events_cursor_pagination(client: TestClient) -> None:
    for i in range(5):
        client.post("/api/wafer", json={"name": f"W{i}"})
    seen: list[str] = []
    cursor = None
    while True:
        params = {"limit": 2} | ({"after": cursor} if cursor else {})
        body = client.get("/api/events", params=params).json()
        if not body["events"]:
            break
        seen.extend(e["id"] for e in body["events"])
        cursor = body["next_cursor"]
    assert len(seen) == len(set(seen)) == 5


def test_malformed_events_cursor_returns_422(client: TestClient) -> None:
    response = client.get("/api/events", params={"after": "not-a-cursor"})
    assert response.status_code == 422
    assert "malformed cursor" in response.json()["detail"]


def test_schema_is_json_schema_with_relations(client: TestClient) -> None:
    schema = client.get("/api/schema").json()
    wafer = schema["entity_types"]["wafer"]
    assert wafer["properties"]["material"]["type"] == "string"
    assert "derived_from" in schema["relations"]


def test_naive_cursor_timestamp_returns_422(client: TestClient) -> None:
    response = client.get(
        "/api/events",
        params={
            "after": (
                "2026-07-19T00:00:00|00000000-0000-0000-0000-000000000000"
            )
        },
    )
    assert response.status_code == 422
    assert "UTC offset" in response.json()["detail"]
