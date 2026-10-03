import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from labcore.lineage import add_edge, lineage, lineage_graph
from labcore.models.edges import RelationType
from labcore.service import create_entity


def test_lineage_graph_projects_reached_nodes_and_traversed_edges(
    session: Session,
) -> None:
    design = create_entity(session, "design", {"name": "rev A"})
    wafer = create_entity(session, "wafer", {"name": "W1"})
    device = create_entity(session, "device", {"name": "device 1"})
    cooldown = create_entity(session, "experiment_setup", {"name": "CD1"})
    add_edge(session, wafer["id"], RelationType.DERIVED_FROM, design["id"])
    add_edge(session, device["id"], RelationType.DERIVED_FROM, wafer["id"])
    add_edge(session, device["id"], RelationType.MEASURED_IN, cooldown["id"])

    graph = lineage_graph(session, device["id"], direction="up")

    assert graph["nodes"] == lineage(session, device["id"], direction="up")
    assert {
        (edge["src_id"], edge["relation"], edge["dst_id"])
        for edge in graph["edges"]
    } == {
        (wafer["id"], "derived_from", design["id"]),
        (device["id"], "derived_from", wafer["id"]),
    }


def test_lineage_graph_respects_direction_and_depth(session: Session) -> None:
    design = create_entity(session, "design", {"name": "rev A"})
    wafer = create_entity(session, "wafer", {"name": "W1"})
    device = create_entity(session, "device", {"name": "device 1"})
    add_edge(session, wafer["id"], RelationType.DERIVED_FROM, design["id"])
    add_edge(session, device["id"], RelationType.DERIVED_FROM, wafer["id"])

    graph = lineage_graph(session, design["id"], direction="down", depth=1)

    assert [node["id"] for node in graph["nodes"]] == [wafer["id"]]
    assert graph["edges"] == [
        {
            "src_id": wafer["id"],
            "dst_id": design["id"],
            "relation": "derived_from",
        }
    ]


def test_lineage_graph_honors_explicit_relation_filter(session: Session) -> None:
    wafer = create_entity(session, "wafer", {"name": "W1"})
    device = create_entity(session, "device", {"name": "device 1"})
    cooldown = create_entity(session, "experiment_setup", {"name": "CD1"})
    add_edge(session, device["id"], RelationType.DERIVED_FROM, wafer["id"])
    add_edge(session, device["id"], RelationType.MEASURED_IN, cooldown["id"])

    graph = lineage_graph(
        session,
        device["id"],
        direction="up",
        relations={RelationType.MEASURED_IN},
    )

    assert graph["nodes"] == [
        {
            "id": cooldown["id"],
            "entity_type": "experiment_setup",
            "accession": cooldown["accession"],
            "depth": 1,
        }
    ]
    assert graph["edges"] == [
        {
            "src_id": device["id"],
            "dst_id": cooldown["id"],
            "relation": "measured_in",
        }
    ]


def test_lineage_api_graph_flag_preserves_default_shape(
    client: TestClient,
) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()
    device = client.post("/api/device", json={"name": "device 1"}).json()
    response = client.post(
        "/api/edges",
        json={
            "src_id": device["id"],
            "relation": "derived_from",
            "dst_id": wafer["id"],
        },
    )
    assert response.status_code == 201

    flat = client.get(f"/api/entities/{device['id']}/lineage")
    graph = client.get(
        f"/api/entities/{device['id']}/lineage", params={"graph": "true"}
    )

    assert isinstance(flat.json(), list)
    assert flat.json() == graph.json()["nodes"]
    assert graph.json()["edges"] == [
        {
            "src_id": device["id"],
            "dst_id": wafer["id"],
            "relation": "derived_from",
        }
    ]


def test_lineage_api_graph_rejects_invalid_direction(
    client: TestClient,
) -> None:
    device = client.post("/api/device", json={"name": "device 1"}).json()

    response = client.get(
        f"/api/entities/{device['id']}/lineage",
        params={"graph": "true", "direction": "sideways"},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "direction must be 'up' or 'down'"


@pytest.mark.parametrize("depth", ["-1", "65", "1000000"])
def test_lineage_api_caps_depth_at_the_boundary(
    client: TestClient, depth: str
) -> None:
    """depth is validated by the query contract: negative rejected, and the
    cap stops an uncapped recursive CTE from expanding without bound."""
    device = client.post("/api/device", json={"name": "device 1"}).json()

    response = client.get(
        f"/api/entities/{device['id']}/lineage",
        params={"graph": "true", "depth": depth},
    )

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["query", "depth"]


def test_lineage_graph_hydrates_names(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "mother wafer"}).json()
    device = client.post(
        "/api/device",
        json={
            "name": "chip 7",
            "links": [{"relation": "derived_from", "dst_id": wafer["id"]}],
        },
    ).json()

    graph = client.get(
        f"/api/entities/{device['id']}/lineage",
        params={"graph": "true", "hydrate": "true"},
    ).json()
    names = {node["accession"]: node["name"] for node in graph["nodes"]}
    assert names[wafer["accession"]] == "mother wafer"

    flat = client.get(
        f"/api/entities/{device['id']}/lineage", params={"hydrate": "true"}
    ).json()
    assert flat[0]["name"] == "mother wafer"
