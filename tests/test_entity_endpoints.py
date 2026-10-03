import uuid

from fastapi.testclient import TestClient


def test_registry_lookup_returns_identity_metadata(client: TestClient) -> None:
    actor = client.post("/api/agent", json={"name": "catalog agent"}).json()
    wafer = client.post(
        "/api/wafer",
        json={"name": "W1"},
        headers={"X-Actor-Id": actor["id"]},
    ).json()

    response = client.get(f"/api/entities/{wafer['id']}/registry")

    assert response.status_code == 200
    registry = response.json()
    assert registry == {
        "id": wafer["id"],
        "entity_type": "wafer",
        "accession": wafer["accession"],
        "source_key": None,
        "version": 0,
        "created_at": wafer["created_at"],
        "updated_at": wafer["updated_at"],
        "created_by_id": actor["id"],
    }

    missing = client.get(f"/api/entities/{uuid.UUID(int=0)}/registry")
    assert missing.status_code == 404


def test_entity_events_are_filtered_and_strictly_paginated(
    client: TestClient,
) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()
    client.post("/api/device", json={"name": "D1"})
    assert client.patch(
        f"/api/wafer/{wafer['id']}", json={"name": "W1b"}
    ).status_code == 200
    client.post("/api/device", json={"name": "D2"})
    assert client.patch(
        f"/api/wafer/{wafer['id']}", json={"name": "W1c"}
    ).status_code == 200

    event_ids: list[str] = []
    actions: list[str] = []
    after: str | None = None
    while True:
        params: dict[str, str | int] = {"limit": 1}
        if after is not None:
            params["after"] = after
        response = client.get(
            f"/api/entities/{wafer['id']}/events",
            params=params,
        )
        assert response.status_code == 200
        assert set(response.json()) == {"events", "next_cursor"}
        page = response.json()
        if not page["events"]:
            assert page["next_cursor"] is None
            break
        assert len(page["events"]) == 1
        event = page["events"][0]
        assert event["entity_id"] == wafer["id"]
        event_ids.append(event["id"])
        actions.append(event["action"])
        after = page["next_cursor"]

    assert actions == ["created", "updated", "updated"]
    assert len(event_ids) == len(set(event_ids)) == 3


def test_entity_events_reject_a_malformed_cursor(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()

    response = client.get(
        f"/api/entities/{wafer['id']}/events",
        params={"after": "not-a-cursor"},
    )

    assert response.status_code == 422


def test_lineage_graph_supports_both_directions_for_related_items(
    client: TestClient,
) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()
    artifact = client.post("/api/artifact", json={"name": "map"}).json()
    note = client.post("/api/note", json={"name": "inspection"}).json()
    for related, relation in ((artifact, "refers_to"), (note, "annotates")):
        response = client.post(
            "/api/edges",
            json={
                "src_id": related["id"],
                "relation": relation,
                "dst_id": wafer["id"],
            },
        )
        assert response.status_code == 201

    response = client.get(
        f"/api/entities/{wafer['id']}/lineage",
        params={
            "direction": "both",
            "depth": 1,
            "relations": "refers_to,annotates",
            "graph": True,
        },
    )

    assert response.status_code == 200
    graph = response.json()
    flat = client.get(
        f"/api/entities/{wafer['id']}/lineage",
        params={
            "direction": "both",
            "depth": 1,
            "relations": "refers_to,annotates",
        },
    ).json()
    assert graph["nodes"] == flat
    assert {node["depth"] for node in graph["nodes"]} == {1}
    assert {
        (node["id"], node["entity_type"])
        for node in graph["nodes"]
    } == {
        (artifact["id"], "artifact"),
        (note["id"], "note"),
    }
    assert {edge["relation"] for edge in graph["edges"]} == {
        "refers_to",
        "annotates",
    }


def test_create_rejects_identity_fields(client: TestClient) -> None:
    response = client.post(
        "/api/wafer",
        json={"name": "forged", "id": str(uuid.uuid4()), "version": 7},
    )
    assert response.status_code == 422
    assert "identity fields" in response.json()["detail"]


def test_fab_step_body_round_trips(client: TestClient) -> None:
    # Run notes live on the step (what changed this time: etch duration,
    # thickness), not in cloned recipes.
    created = client.post(
        "/api/fab_step",
        json={"name": "Sputter Hf", "step_index": 3, "body": "36 s at 300 W"},
    )
    assert created.status_code == 201
    step_id = created.json()["id"]

    fetched = client.get(f"/api/fab_step/{step_id}")
    assert fetched.status_code == 200
    assert fetched.json()["body"] == "36 s at 300 W"
    assert "body" not in fetched.json()["extra"]


def test_constraint_violations_return_409_not_500(client: TestClient) -> None:
    first = client.post(
        "/api/fab_step",
        json={"name": "etch", "step_index": 0},
    )
    assert first.status_code == 201

    negative_index = client.post(
        "/api/fab_step",
        json={"name": "bad", "step_index": -1},
    )
    assert negative_index.status_code == 409
