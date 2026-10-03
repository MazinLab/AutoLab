from fastapi.testclient import TestClient

# the shared `client` fixture comes from tests/conftest.py


def test_edge_and_lineage_roundtrip(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()
    device = client.post("/api/device", json={"name": "D1"}).json()
    r = client.post(
        "/api/edges",
        json={
            "src_id": device["id"],
            "relation": "derived_from",
            "dst_id": wafer["id"],
        },
    )
    assert r.status_code == 201
    up = client.get(f"/api/entities/{device['id']}/lineage",
                    params={"direction": "up"}).json()
    assert [e["accession"] for e in up] == [wafer["accession"]]


def test_bad_relation_422(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()
    device = client.post("/api/device", json={"name": "D1"}).json()
    r = client.post(
        "/api/edges",
        json={"src_id": device["id"], "relation": "begat",
              "dst_id": wafer["id"]},
    )
    assert r.status_code == 422


def test_search_across_types(client: TestClient) -> None:
    client.post("/api/wafer", json={"name": "hafnium test wafer"})
    client.post("/api/device", json={"name": "dev A",
                                     "description": "hafnium MKID"})
    client.post("/api/project", json={"name": "unrelated"})
    hits = client.get("/api/search", params={"q": "hafnium"}).json()
    assert {h["entity_type"] for h in hits} == {"wafer", "device"}


def test_search_escapes_like_wildcards(client: TestClient) -> None:
    client.post("/api/wafer", json={"name": "100% yield wafer"})
    client.post("/api/device", json={"name": "plain device"})
    client.post("/api/project", json={"name": "under_score run"})

    percent = client.get("/api/search", params={"q": "100%"}).json()
    assert [h["name"] for h in percent] == ["100% yield wafer"]

    underscore = client.get("/api/search", params={"q": "under_s"}).json()
    assert [h["name"] for h in underscore] == ["under_score run"]

    # a bare wildcard matches only literal occurrences, not everything
    bare = client.get("/api/search", params={"q": "%"}).json()
    assert [h["name"] for h in bare] == ["100% yield wafer"]


def test_search_limit_is_applied_after_global_sort(client: TestClient) -> None:
    client.post("/api/wafer", json={"name": "zeta shared"})
    client.post("/api/device", json={"name": "alpha shared"})

    hits = client.get(
        "/api/search", params={"q": "shared", "limit": 1}
    ).json()
    assert len(hits) == 1
    assert hits[0]["entity_type"] == "device"
    assert hits[0]["name"] == "alpha shared"


def test_search_matches_accession(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "plain name"}).json()

    hits = client.get(
        "/api/search", params={"q": wafer["accession"]}
    ).json()

    assert [hit["accession"] for hit in hits] == [wafer["accession"]]
