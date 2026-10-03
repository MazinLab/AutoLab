from fastapi.testclient import TestClient


def _project(client: TestClient) -> str:
    return client.post("/api/project", json={"name": "Air Bridge MKIDs"}).json()["id"]


def test_item_endpoints_round_trip(client: TestClient) -> None:
    pid = _project(client)
    created = client.post(
        f"/api/project/{pid}/items",
        json={"kind": "milestone", "title": "First wafer", "target_date": "2026-10-15"},
    )
    assert created.status_code == 201
    item = created.json()
    assert item["target_date"] == "2026-10-15"

    assert client.post(
        f"/api/project/{pid}/items", json={"kind": "goal", "title": "G", "target_date": "2026-01-01"}
    ).status_code == 422

    patched = client.patch(
        f"/api/project/{pid}/items/{item['id']}", json={"title": "First wafer out"}
    )
    assert patched.status_code == 200 and patched.json()["title"] == "First wafer out"

    done = client.post(f"/api/project/{pid}/items/{item['id']}/done", json={"done": True})
    assert done.status_code == 200 and done.json()["done_at"] is not None

    second = client.post(
        f"/api/project/{pid}/items", json={"kind": "milestone", "title": "Second"}
    ).json()
    reordered = client.post(
        f"/api/project/{pid}/items/reorder",
        json={"kind": "milestone", "item_ids": [second["id"], item["id"]]},
    )
    assert reordered.status_code == 200
    assert [i["title"] for i in reordered.json()] == ["Second", "First wafer out"]
    assert client.post(
        f"/api/project/{pid}/items/reorder",
        json={"kind": "milestone", "item_ids": [second["id"]]},
    ).status_code == 422

    listed = client.get(f"/api/project/{pid}/items").json()
    assert [m["title"] for m in listed["milestones"]] == ["Second", "First wafer out"]

    assert client.delete(f"/api/project/{pid}/items/{item['id']}").status_code == 204
    assert client.delete(f"/api/project/{pid}/items/{item['id']}").status_code == 404


def test_report_and_not_found(client: TestClient) -> None:
    pid = _project(client)
    wafer = client.post("/api/wafer", json={"name": "W", "project_id": pid}).json()
    report = client.get(f"/api/project/{pid}/report").json()
    assert report["project"]["id"] == pid
    assert report["work"]["wafer"]["count"] == 1
    assert report["work"]["wafer"]["recent"][0]["id"] == wafer["id"]
    other = client.post("/api/wafer", json={"name": "X"}).json()["id"]
    assert client.get(f"/api/project/{other}/report").status_code == 404
    assert client.get(f"/api/project/{other}/items").status_code == 404


def test_project_routes_take_precedence_over_generic_entity_route(
    client: TestClient,
) -> None:
    pid = _project(client)
    # Still reachable as an ordinary entity.
    assert client.get(f"/api/project/{pid}").status_code == 200
    # And the sub-resources are not swallowed by /{entity_type}/{entity_id}.
    assert client.get(f"/api/project/{pid}/items").status_code == 200


def test_list_filters_by_project_and_validates_reference(client: TestClient) -> None:
    pid = _project(client)
    client.post("/api/wafer", json={"name": "In", "project_id": pid})
    client.post("/api/wafer", json={"name": "Out"})
    client.post("/api/note", json={"name": "E", "template": "Experiment", "project_id": pid})
    wafers = client.get(f"/api/wafer?f.project_id={pid}").json()
    assert [w["name"] for w in wafers] == ["In"]
    notes = client.get(f"/api/note?f.project_id={pid}&f.template=Experiment").json()
    assert [n["name"] for n in notes] == ["E"]
    bad = client.post("/api/wafer", json={"name": "Bad", "project_id": pid[:-4] + "0000"})
    assert bad.status_code == 422


def test_delete_project_with_work_is_409(client: TestClient) -> None:
    pid = _project(client)
    client.post("/api/device", json={"name": "D", "project_id": pid})
    r = client.delete(f"/api/project/{pid}")
    assert r.status_code == 409 and "still contains 1" in r.json()["detail"]


def test_schema_lists_project_item_table(client: TestClient) -> None:
    schema = client.get("/api/schema").json()
    assert "project_item" in schema["tables"]
    assert "project_id" in schema["entity_types"]["wafer"]["properties"]
    assert "status" in schema["entity_types"]["project"]["properties"]
