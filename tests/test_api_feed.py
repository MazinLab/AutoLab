"""GET /api/feed: reverse chronological activity, hydrated for display."""

from __future__ import annotations

from fastapi.testclient import TestClient


def _items_are_newest_first(items: list[dict]) -> bool:
    keys = [(item["at"], item["id"]) for item in items]
    return keys == sorted(keys, reverse=True)


def test_feed_returns_hydrated_items_newest_first(
    client: TestClient,
) -> None:
    person = client.post("/api/person", json={"name": "Ben"}).json()
    wafer = client.post(
        "/api/wafer",
        json={"name": "W-alpha"},
        headers={"X-Actor-Id": str(person["id"])},
    ).json()
    client.patch(
        f"/api/wafer/{wafer['id']}",
        json={"material": "Si"},
        headers={"X-Actor-Id": str(person["id"])},
    )

    feed = client.get("/api/feed").json()
    items = feed["items"]

    assert len(items) == 3
    assert _items_are_newest_first(items)
    assert items[0]["action"] == "updated"
    assert items[0]["entity"] == {
        "id": wafer["id"],
        "entity_type": "wafer",
        "accession": wafer["accession"],
        "name": "W-alpha",
    }
    assert items[0]["actor"]["name"] == "Ben"
    assert items[0]["actor"]["entity_type"] == "person"
    person_created = items[-1]
    assert person_created["action"] == "created"
    assert person_created["actor"] is None
    assert feed["next_cursor"] is None


def test_feed_paginates_with_strict_before_cursor(
    client: TestClient,
) -> None:
    for index in range(5):
        client.post("/api/device", json={"name": f"D{index}"})

    first = client.get("/api/feed", params={"limit": 2}).json()
    assert len(first["items"]) == 2
    assert first["next_cursor"] is not None

    seen = [item["id"] for item in first["items"]]
    cursor = first["next_cursor"]
    while cursor is not None:
        page = client.get(
            "/api/feed", params={"limit": 2, "before": cursor}
        ).json()
        seen.extend(item["id"] for item in page["items"])
        cursor = page["next_cursor"]

    assert len(seen) == len(set(seen)) == 5


def test_feed_filters_actions(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "W"}).json()
    device = client.post("/api/device", json={"name": "D"}).json()
    client.post(
        "/api/edges",
        json={
            "src_id": device["id"],
            "relation": "derived_from",
            "dst_id": wafer["id"],
        },
    )
    client.patch(f"/api/wafer/{wafer['id']}", json={"material": "Si"})

    only_writes = client.get(
        "/api/feed", params={"actions": "created,updated"}
    ).json()["items"]
    assert {item["action"] for item in only_writes} == {"created", "updated"}

    everything = client.get("/api/feed").json()["items"]
    assert {item["action"] for item in everything} == {
        "created",
        "updated",
        "linked",
    }


def test_feed_rejects_naive_cursor(client: TestClient) -> None:
    response = client.get(
        "/api/feed",
        params={
            "before": (
                "2026-07-19T00:00:00|00000000-0000-0000-0000-000000000000"
            )
        },
    )
    assert response.status_code == 422


def test_feed_date_range_bounds_results(client: TestClient) -> None:
    client.post("/api/wafer", json={"name": "ranged"})
    everything = client.get("/api/feed").json()["items"]
    assert everything
    stamp = everything[0]["at"]

    inside = client.get(
        "/api/feed", params={"since": stamp, "until": stamp}
    ).json()["items"]
    future_only = client.get(
        "/api/feed", params={"since": "2099-01-01T00:00:00"}
    ).json()["items"]
    past_only = client.get(
        "/api/feed", params={"until": "2000-01-01T00:00:00"}
    ).json()["items"]

    assert any(item["at"] == stamp for item in inside)
    assert future_only == []
    assert past_only == []
