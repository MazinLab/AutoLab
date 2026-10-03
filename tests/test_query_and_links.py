import uuid

from fastapi.testclient import TestClient


def _mk(client: TestClient, entity_type: str, payload: dict) -> dict:
    response = client.post(f"/api/{entity_type}", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


class TestAtomicLinks:
    def test_create_with_links_creates_entity_and_edges(
        self, client: TestClient
    ) -> None:
        wafer = _mk(client, "wafer", {"name": "W1"})

        device = _mk(
            client,
            "device",
            {
                "name": "W1-C1",
                "links": [
                    {"relation": "derived_from", "dst_id": wafer["id"]}
                ],
            },
        )

        lineage = client.get(
            f"/api/entities/{device['id']}/lineage"
        ).json()
        assert [node["id"] for node in lineage] == [wafer["id"]]

    def test_link_by_accession(self, client: TestClient) -> None:
        wafer = _mk(client, "wafer", {"name": "W1"})

        device = _mk(
            client,
            "device",
            {
                "name": "W1-C1",
                "links": [
                    {
                        "relation": "derived_from",
                        "dst_accession": wafer["accession"],
                    }
                ],
            },
        )

        lineage = client.get(
            f"/api/entities/{device['id']}/lineage"
        ).json()
        assert [node["id"] for node in lineage] == [wafer["id"]]

    def test_bad_link_rolls_back_the_entity(self, client: TestClient) -> None:
        response = client.post(
            "/api/device",
            json={
                "name": "orphan",
                "links": [
                    {"relation": "derived_from", "dst_id": str(uuid.uuid4())}
                ],
            },
        )

        assert response.status_code == 422
        assert client.get("/api/device").json() == []

    def test_source_key_replay_reapplies_links_idempotently(
        self, client: TestClient
    ) -> None:
        wafer = _mk(client, "wafer", {"name": "W1"})
        payload = {
            "name": "W1-C1",
            "source_key": "replay-1",
            "links": [{"relation": "derived_from", "dst_id": wafer["id"]}],
        }

        first = _mk(client, "device", payload)
        second = _mk(client, "device", dict(payload))

        assert second["id"] == first["id"]
        lineage = client.get(f"/api/entities/{first['id']}/lineage").json()
        assert [node["id"] for node in lineage] == [wafer["id"]]

    def test_artifact_registration_with_links(
        self, client: TestClient
    ) -> None:
        instrument = _mk(client, "instrument", {"name": "VNA"})

        artifact = client.post(
            "/api/artifact",
            json={
                "name": "sweep",
                "links": [
                    {"relation": "produced_by", "dst_id": instrument["id"]}
                ],
            },
        )
        assert artifact.status_code == 201

        events = client.get("/api/events").json()["events"]
        assert [e["action"] for e in events].count("linked") == 1


class TestListFiltering:
    def test_typed_field_filter(self, client: TestClient) -> None:
        _mk(client, "wafer", {"name": "Si wafer", "material": "Si"})
        _mk(client, "wafer", {"name": "Sapphire wafer", "material": "Al2O3"})

        rows = client.get("/api/wafer", params={"f.material": "Si"}).json()

        assert [row["name"] for row in rows] == ["Si wafer"]

    def test_extra_field_filter(self, client: TestClient) -> None:
        _mk(client, "note", {"name": "run log", "template": "Experiment"})
        _mk(
            client,
            "note",
            {"name": "oddball", "vendor_lot": "LOT-7"},
        )

        rows = client.get("/api/note", params={"x.vendor_lot": "LOT-7"}).json()

        assert [row["name"] for row in rows] == ["oddball"]

    def test_q_matches_name_and_description(self, client: TestClient) -> None:
        _mk(client, "wafer", {"name": "W1", "description": "trilayer stack"})
        _mk(client, "wafer", {"name": "W2"})

        rows = client.get("/api/wafer", params={"q": "trilayer"}).json()

        assert [row["name"] for row in rows] == ["W1"]

    def test_with_count_header(self, client: TestClient) -> None:
        for index in range(3):
            _mk(client, "wafer", {"name": f"W{index}"})

        response = client.get(
            "/api/wafer", params={"limit": 1, "with_count": "true"}
        )

        assert len(response.json()) == 1
        assert response.headers["X-Total-Count"] == "3"

    def test_unknown_param_and_field_are_422(self, client: TestClient) -> None:
        assert (
            client.get("/api/wafer", params={"bogus": "1"}).status_code == 422
        )
        assert (
            client.get("/api/wafer", params={"f.bogus": "1"}).status_code
            == 422
        )

    def test_order_by_updated(self, client: TestClient) -> None:
        first = _mk(client, "wafer", {"name": "older"})
        _mk(client, "wafer", {"name": "newer"})
        client.patch(f"/api/wafer/{first['id']}", json={"description": "touched"})

        rows = client.get(
            "/api/wafer", params={"order_by": "updated", "order": "desc"}
        ).json()

        assert rows[0]["name"] == "older"


class TestSearchBodies:
    def test_search_finds_note_body_and_returns_snippet(
        self, client: TestClient
    ) -> None:
        _mk(
            client,
            "note",
            {
                "name": "cooldown 41 log",
                "body": "Loaded the array. Witnessed xyzzy-marker at 95 mK.",
            },
        )

        hits = client.get("/api/search", params={"q": "xyzzy-marker"}).json()

        assert [hit["name"] for hit in hits] == ["cooldown 41 log"]
        assert "xyzzy-marker" in hits[0]["snippet"]


class TestFeedFilters:
    def test_feed_filters_by_actor_and_entity_type(
        self, client: TestClient
    ) -> None:
        alice = _mk(client, "person", {"name": "Alice"})
        bob = _mk(client, "person", {"name": "Bob"})
        client.post(
            "/api/wafer",
            json={"name": "W-alice"},
            headers={"X-Actor-Id": alice["id"]},
        )
        client.post(
            "/api/device",
            json={"name": "D-bob"},
            headers={"X-Actor-Id": bob["id"]},
        )

        by_actor = client.get(
            "/api/feed", params={"actor": alice["id"]}
        ).json()["items"]
        assert {item["entity"]["name"] for item in by_actor} == {"W-alice"}

        by_type = client.get(
            "/api/feed", params={"entity_type": "device"}
        ).json()["items"]
        assert {item["entity"]["name"] for item in by_type} == {"D-bob"}

        assert (
            client.get(
                "/api/feed", params={"entity_type": "bogus"}
            ).status_code
            == 422
        )


class TestMetaEndpoints:
    def test_health(self, client: TestClient) -> None:
        response = client.get("/api/health")

        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    def test_schema_write_contract(self, client: TestClient) -> None:
        wafer_schema = client.get("/api/schema").json()["entity_types"][
            "wafer"
        ]

        assert "id" not in wafer_schema.get("required", [])
        assert wafer_schema["properties"]["id"]["readOnly"] is True
        assert "source_key" in wafer_schema["properties"]
        assert "links" in wafer_schema["properties"]
