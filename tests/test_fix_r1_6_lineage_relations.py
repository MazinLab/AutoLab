"""FIX-R1-6: the lineage endpoint gains a ``relations`` query param.

The mount-for-cooldown flow needs to find the cooldowns PERFORMED_ON a fridge
instrument without scanning the entire append-only event feed client-side.
Exposing relation-filtered lineage turns that O(total events) scan into an
indexed edge query (bead Autolab-6yw).
"""

from fastapi.testclient import TestClient


def _make(client: TestClient, entity_type: str, name: str) -> dict:
    response = client.post(f"/api/{entity_type}", json={"name": name})
    assert response.status_code in (200, 201), response.text
    return response.json()


def test_relations_param_filters_to_performed_on_cooldowns(
    client: TestClient,
) -> None:
    instrument = _make(client, "instrument", "Blue fridge")
    linked = _make(client, "experiment_setup", "July run")
    other_instrument = _make(client, "instrument", "Red fridge")
    unlinked = _make(client, "experiment_setup", "Elsewhere run")

    assert (
        client.post(
            "/api/edges",
            json={
                "src_id": linked["id"],
                "relation": "performed_on",
                "dst_id": instrument["id"],
            },
        ).status_code
        == 201
    )
    assert (
        client.post(
            "/api/edges",
            json={
                "src_id": unlinked["id"],
                "relation": "performed_on",
                "dst_id": other_instrument["id"],
            },
        ).status_code
        == 201
    )

    graph = client.get(
        f"/api/entities/{instrument['id']}/lineage",
        params={
            "graph": "true",
            "direction": "down",
            "depth": 1,
            "relations": "performed_on",
        },
    ).json()

    assert [node["id"] for node in graph["nodes"]] == [linked["id"]]
    assert graph["edges"] == [
        {
            "src_id": linked["id"],
            "dst_id": instrument["id"],
            "relation": "performed_on",
        }
    ]


def test_relations_param_absent_keeps_structural_default(client: TestClient) -> None:
    wafer = _make(client, "wafer", "W1")
    device = _make(client, "device", "D1")
    cooldown = _make(client, "experiment_setup", "CD1")
    client.post(
        "/api/edges",
        json={
            "src_id": device["id"],
            "relation": "derived_from",
            "dst_id": wafer["id"],
        },
    )
    client.post(
        "/api/edges",
        json={
            "src_id": device["id"],
            "relation": "mounted_in",
            "dst_id": cooldown["id"],
        },
    )

    default = client.get(
        f"/api/entities/{device['id']}/lineage", params={"direction": "up"}
    ).json()

    # measured/mounted edges are not ancestry; only the structural derived_from
    # wafer is reached when no relations filter is supplied.
    assert [node["accession"] for node in default] == [wafer["accession"]]


def test_unknown_relation_name_returns_422(client: TestClient) -> None:
    device = _make(client, "device", "D1")
    response = client.get(
        f"/api/entities/{device['id']}/lineage",
        params={"relations": "begat"},
    )
    assert response.status_code == 422
