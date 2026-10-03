"""The wafer fab-flow view: ordered steps with their recipe and machine."""

from fastapi.testclient import TestClient


def _link(client: TestClient, src: str, relation: str, dst: str) -> None:
    response = client.post(
        "/api/edges",
        json={"src_id": src, "relation": relation, "dst_id": dst},
    )
    assert response.status_code == 201


def test_fab_flow_orders_steps_and_resolves_recipe_and_machine(
    client: TestClient,
) -> None:
    wafer = client.post("/api/wafer", json={"name": "W20260812-1"}).json()
    sputter = client.post(
        "/api/fab_recipe", json={"name": "Hf sputter"}
    ).json()
    etch = client.post("/api/fab_recipe", json={"name": "BCl3 etch"}).json()
    machine = client.post(
        "/api/instrument", json={"name": "AJA Sputter", "category": "fab"}
    ).json()

    # Created out of order on purpose: step_index, not creation time, is the
    # sequence the fab crew reads.
    second = client.post(
        "/api/fab_step", json={"step_index": 2, "body": "36 s at 300 W"}
    ).json()
    first = client.post("/api/fab_step", json={"step_index": 1}).json()
    for step in (first, second):
        _link(client, step["id"], "refers_to", wafer["id"])
    _link(client, first["id"], "refers_to", sputter["id"])
    _link(client, first["id"], "performed_on", machine["id"])
    _link(client, second["id"], "refers_to", etch["id"])

    flow = client.get(f"/api/entities/{wafer['id']}/fab_flow")
    assert flow.status_code == 200
    steps = flow.json()["steps"]

    assert [step["step_index"] for step in steps] == [1, 2]
    assert steps[0]["accession"] == first["accession"]
    assert steps[0]["recipe"]["name"] == "Hf sputter"
    assert steps[0]["recipe"]["id"] == sputter["id"]
    assert steps[0]["instrument"]["name"] == "AJA Sputter"
    assert steps[1]["recipe"]["name"] == "BCl3 etch"
    assert steps[1]["body"] == "36 s at 300 W"
    # A step with no machine linked still renders; the field is just empty.
    assert steps[1]["instrument"] is None
    assert steps[0]["created_at"]


def test_fab_flow_ignores_other_wafers_and_non_step_referrers(
    client: TestClient,
) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()
    other = client.post("/api/wafer", json={"name": "W2"}).json()
    mine = client.post("/api/fab_step", json={"step_index": 1}).json()
    theirs = client.post("/api/fab_step", json={"step_index": 1}).json()
    note = client.post("/api/note", json={"name": "Fab note"}).json()
    _link(client, mine["id"], "refers_to", wafer["id"])
    _link(client, theirs["id"], "refers_to", other["id"])
    _link(client, note["id"], "refers_to", wafer["id"])

    steps = client.get(f"/api/entities/{wafer['id']}/fab_flow").json()["steps"]

    assert [step["id"] for step in steps] == [mine["id"]]


def test_fab_flow_is_empty_for_a_wafer_with_no_steps(
    client: TestClient,
) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()

    response = client.get(f"/api/entities/{wafer['id']}/fab_flow")

    assert response.status_code == 200
    assert response.json() == {"steps": []}


def test_fab_flow_404s_for_an_unknown_entity(client: TestClient) -> None:
    missing = "01900000-0000-7000-8000-0000000009ff"

    assert client.get(f"/api/entities/{missing}/fab_flow").status_code == 404


def test_fab_flow_breaks_step_index_ties_by_creation(
    client: TestClient,
) -> None:
    """Duplicate indices are legal (people re-run a step); keep them stable."""
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()
    earlier = client.post("/api/fab_step", json={"step_index": 3}).json()
    later = client.post("/api/fab_step", json={"step_index": 3}).json()
    _link(client, later["id"], "refers_to", wafer["id"])
    _link(client, earlier["id"], "refers_to", wafer["id"])

    steps = client.get(f"/api/entities/{wafer['id']}/fab_flow").json()["steps"]

    assert [step["id"] for step in steps] == [earlier["id"], later["id"]]
