"""Setup designer API: parts, evaluate, layout GET/PUT, persistence contract."""

from __future__ import annotations

import copy

from fastapi.testclient import TestClient

from tests.test_rfchain import EXAMPLE


def layout() -> dict:
    doc = copy.deepcopy(EXAMPLE)
    doc["chains"] = doc["chains"][:2]  # feedline A only
    return doc


def _testbed(client: TestClient) -> dict:
    return client.post(
        "/api/instrument",
        json={"name": "Blue Fridge", "category": "testbed", "kind": "dilution_refrigerator"},
    ).json()


def _hemt(client: TestClient, name: str = "LNF 3") -> dict:
    return client.post(
        "/api/instrument",
        json={"name": name, "category": "experimental", "kind": "HEMT", "gain_db": 40, "noise_temp_k": 1.0},
    ).json()


def _setup(client: TestClient, testbed: dict, **fields) -> dict:
    body = {"name": "Cooldown 1", "links": [{"relation": "performed_on", "dst_id": testbed["id"]}], **fields}
    response = client.post("/api/experiment_setup", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _edges(client: TestClient, setup_id: str) -> list[dict]:
    graph = client.get(
        f"/api/entities/{setup_id}/lineage?direction=down&depth=1&relations=mounted_in&graph=true"
    ).json()
    return graph["edges"]


def test_parts_and_evaluate(client: TestClient) -> None:
    parts = client.get("/api/rf/parts").json()
    assert parts["version"] == 1
    assert any(p["id"] == "hemt" and p["bindable"] for p in parts["parts"])
    good = client.post("/api/rf/evaluate", json={"layout": layout()})
    assert good.status_code == 200
    assert good.json()["feedlines"]["A"]["output"]["gain_db"] == 37.5
    bad = copy.deepcopy(layout())
    bad["chains"][0]["parts"][0]["type"] = "nope"
    assert client.post("/api/rf/evaluate", json={"layout": bad}).status_code == 422


def test_layout_put_stores_snapshot_reconciles_edges_and_checks_etag(client: TestClient) -> None:
    testbed = _testbed(client)
    hemt = _hemt(client)
    other = _hemt(client, "LNF 4")
    setup = _setup(client, testbed)
    # A manually made equipment link that the designer must never remove.
    client.post("/api/edges", json={"src_id": other["id"], "relation": "mounted_in", "dst_id": setup["id"]})

    got = client.get(f"/api/experiment_setup/{setup['id']}/layout")
    assert got.status_code == 200 and got.headers["ETag"] == '"v0"'
    assert got.json() == {"layout": {}, "evaluation": None, "saved_evaluation": None}

    doc = layout()
    doc["chains"][1]["parts"][2]["instrument_id"] = hemt["id"]
    put = client.put(
        f"/api/experiment_setup/{setup['id']}/layout",
        json={"layout": doc},
        headers={"If-Match": '"v0"'},
    )
    assert put.status_code == 200, put.text
    body = put.json()
    assert put.headers["ETag"] == '"v1"'
    assert body["evaluation"]["feedlines"]["A"]["output"]["gain_db"] == 39.5
    assert body["saved_evaluation"]["feedlines"]["A"]["output"]["gain_db"] == 39.5
    assert body["saved_evaluation"]["evaluated_at"]
    sources = {e["src_id"] for e in _edges(client, setup["id"])}
    assert {hemt["id"], other["id"]} <= sources

    stale = client.put(
        f"/api/experiment_setup/{setup['id']}/layout",
        json={"layout": doc},
        headers={"If-Match": '"v0"'},
    )
    assert stale.status_code == 412

    # Unbind: the designer's edge goes, the manual one stays.
    doc["chains"][1]["parts"][2].pop("instrument_id")
    put2 = client.put(f"/api/experiment_setup/{setup['id']}/layout", json={"layout": doc})
    assert put2.status_code == 200
    sources = {e["src_id"] for e in _edges(client, setup["id"])}
    assert hemt["id"] not in sources and other["id"] in sources


def test_historical_snapshot_survives_amplifier_edits(client: TestClient) -> None:
    testbed = _testbed(client)
    hemt = _hemt(client)
    doc = layout()
    doc["chains"][1]["parts"][2]["instrument_id"] = hemt["id"]
    setup = _setup(client, testbed, layout=doc)
    # Create-time binding made the edge and the snapshot.
    assert hemt["id"] in {e["src_id"] for e in _edges(client, setup["id"])}
    client.patch(f"/api/instrument/{hemt['id']}", json={"noise_temp_k": 5.0})
    got = client.get(f"/api/experiment_setup/{setup['id']}/layout").json()
    live = got["evaluation"]["feedlines"]["A"]["output"]["parts"][2]
    saved = got["saved_evaluation"]["feedlines"]["A"]["output"]["parts"][2]
    assert live["noise_k"] == 5.0 and saved["noise_k"] == 1.0


def test_generic_patch_and_default_layout_run_validation(client: TestClient) -> None:
    testbed = _testbed(client)
    setup = _setup(client, testbed)
    bad = layout()
    bad["chains"][0]["parts"][0]["stage"] = "nowhere"
    assert client.patch(f"/api/experiment_setup/{setup['id']}", json={"layout": bad}).status_code == 422
    assert client.patch(f"/api/instrument/{testbed['id']}", json={"default_layout": bad}).status_code == 422
    good = client.patch(f"/api/instrument/{testbed['id']}", json={"default_layout": layout()})
    assert good.status_code == 200 and good.json()["default_layout"]["version"] == 1
    bound_to_wafer = layout()
    wafer = client.post("/api/wafer", json={"name": "W"}).json()
    bound_to_wafer["chains"][1]["parts"][2]["instrument_id"] = wafer["id"]
    r = client.patch(f"/api/experiment_setup/{setup['id']}", json={"layout": bound_to_wafer})
    assert r.status_code == 422 and "non-instrument" in r.json()["detail"]


def test_layout_routes_are_scoped_to_setups(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "W"}).json()
    assert client.get(f"/api/experiment_setup/{wafer['id']}/layout").status_code == 404


def test_feedline_device_binding_links_and_names_the_device(client: TestClient) -> None:
    testbed = _testbed(client)
    device = client.post("/api/device", json={"name": "AB chip 4"}).json()
    setup = _setup(client, testbed)
    doc = layout()
    doc["feedlines"] = {"A": {"device_id": device["id"]}}
    put = client.put(f"/api/experiment_setup/{setup['id']}/layout", json={"layout": doc})
    assert put.status_code == 200, put.text
    feedline = put.json()["evaluation"]["feedlines"]["A"]
    assert feedline["device"] == {"id": device["id"], "name": "AB chip 4", "accession": device["accession"]}
    assert device["id"] in {e["src_id"] for e in _edges(client, setup["id"])}
    bad = layout()
    bad["feedlines"] = {"A": {"device_id": testbed["id"]}}
    r = client.put(f"/api/experiment_setup/{setup['id']}/layout", json={"layout": bad})
    assert r.status_code == 422 and "non-device" in r.json()["detail"]
    # Unbinding removes the designer's edge.
    put2 = client.put(f"/api/experiment_setup/{setup['id']}/layout", json={"layout": layout()})
    assert put2.status_code == 200
    assert device["id"] not in {e["src_id"] for e in _edges(client, setup["id"])}


def test_testbed_default_drops_device_bindings(client: TestClient) -> None:
    testbed = _testbed(client)
    device = client.post("/api/device", json={"name": "chip"}).json()
    doc = layout()
    doc["feedlines"] = {"A": {"device_id": device["id"]}}
    r = client.patch(f"/api/instrument/{testbed['id']}", json={"default_layout": doc})
    assert r.status_code == 200
    assert r.json()["default_layout"]["feedlines"] == {"A": {}}


def test_through_line_binds_without_a_catalog_device_and_survives_the_testbed_default(
    client: TestClient,
) -> None:
    testbed = _testbed(client)
    setup = _setup(client, testbed)
    doc = layout()
    doc["feedlines"] = {"A": {"device_id": "through"}}
    put = client.put(f"/api/experiment_setup/{setup['id']}/layout", json={"layout": doc})
    assert put.status_code == 200, put.text
    assert put.json()["evaluation"]["feedlines"]["A"]["device"]["through"] is True
    assert all(e["relation"] != "mounted_in" for e in _edges(client, setup["id"]))
    r = client.patch(f"/api/instrument/{testbed['id']}", json={"default_layout": doc})
    assert r.status_code == 200
    assert r.json()["default_layout"]["feedlines"] == {"A": {"device_id": "through"}}
