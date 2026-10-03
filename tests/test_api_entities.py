from fastapi.testclient import TestClient


def test_create_and_get_wafer(client: TestClient) -> None:
    r = client.post("/api/wafer", json={"name": "W1", "material": "Al/Si"})
    assert r.status_code == 201
    body = r.json()
    assert body["accession"].startswith("W-")
    r2 = client.get(f"/api/wafer/{body['id']}")
    assert r2.status_code == 200
    assert r2.json()["material"] == "Al/Si"


def test_design_repo_url_is_a_typed_column(client: TestClient) -> None:
    created = client.post(
        "/api/design",
        json={
            "name": "MEC layout",
            "repo_url": "https://github.com/MazinLab/mec-layout",
            "git_commit": "abc1234",
        },
    ).json()
    fetched = client.get(f"/api/design/{created['id']}").json()
    assert fetched["repo_url"] == "https://github.com/MazinLab/mec-layout"
    assert fetched["git_commit"] == "abc1234"
    assert "repo_url" not in fetched["extra"]


def test_accession_resolver(client: TestClient) -> None:
    acc = client.post("/api/device", json={"name": "D1"}).json()["accession"]
    r = client.get(f"/api/e/{acc}")
    assert r.status_code == 200
    assert r.json()["entity_type"] == "device"
    assert client.get("/api/e/W-9999-0001").status_code == 404


def test_unknown_entity_type_404(client: TestClient) -> None:
    assert client.post("/api/gizmo", json={"name": "x"}).status_code == 404


def test_patch_and_identity_rejection(client: TestClient) -> None:
    made = client.post("/api/wafer", json={"name": "W1"}).json()
    r = client.patch(f"/api/wafer/{made['id']}", json={"material": "Nb"})
    assert r.status_code == 200
    assert r.json()["material"] == "Nb"
    r2 = client.patch(f"/api/wafer/{made['id']}", json={"accession": "nope"})
    assert r2.status_code == 422


def test_cross_type_patch_is_404_and_mutates_nothing(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1", "material": "Al"}).json()
    r = client.patch(f"/api/device/{wafer['id']}", json={"material": "Nb"})
    assert r.status_code == 404
    unchanged = client.get(f"/api/wafer/{wafer['id']}").json()
    assert unchanged["material"] == "Al"
    assert unchanged["updated_at"] == wafer["updated_at"]


def test_list_with_pagination(client: TestClient) -> None:
    for i in range(3):
        client.post("/api/device", json={"name": f"device {i}"})
    assert len(client.get("/api/device", params={"limit": 2}).json()) == 2


def test_actor_header_attribution(client: TestClient) -> None:
    agent = client.post("/api/agent", json={"name": "fable"}).json()
    r = client.post(
        "/api/wafer",
        json={"name": "W1"},
        headers={"X-Actor-Id": agent["id"]},
    )
    assert r.status_code == 201
    assert r.json()["created_by_id"] == agent["id"]
    bad = client.post(
        "/api/wafer",
        json={"name": "W2"},
        headers={"X-Actor-Id": "00000000-0000-4000-8000-000000000000"},
    )
    assert bad.status_code == 422
