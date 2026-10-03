from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlmodel import Session

from labcore.lineage import add_edge
from labcore.lineage_label import lineage_label
from labcore.models.edges import RelationType
from labcore.service import create_entity


def test_lineage_label_uses_names_or_accession_fallbacks(
    session: Session,
) -> None:
    design = create_entity(session, "design", {"name": "rev.one"})
    wafer = create_entity(session, "wafer", {"name": "W20260312-3"})
    device = create_entity(session, "device", {"name": "C1"})
    cooldown = create_entity(session, "experiment_setup", {"name": "CD1"})
    add_edge(session, wafer["id"], RelationType.DERIVED_FROM, design["id"])
    add_edge(session, device["id"], RelationType.DERIVED_FROM, wafer["id"])
    add_edge(session, device["id"], RelationType.MEASURED_IN, cooldown["id"])

    assert lineage_label(session, device["id"]) == (
        f"{design['accession']}.W20260312-3.C1"
    )
    assert lineage_label(session, design["id"]) == design["accession"]


def test_lineage_label_parent_choice_is_deterministic(session: Session) -> None:
    lower_accession = create_entity(session, "wafer", {"name": "Lower"})
    higher_accession = create_entity(session, "wafer", {"name": "Higher"})
    child = create_entity(session, "device", {"name": "Child"})

    older_edge = add_edge(
        session,
        child["id"],
        RelationType.DERIVED_FROM,
        higher_accession["id"],
    )
    newer_edge = add_edge(
        session,
        child["id"],
        RelationType.DERIVED_FROM,
        lower_accession["id"],
    )
    older_edge.created_at = datetime(2026, 1, 1, tzinfo=UTC)
    newer_edge.created_at = datetime(2026, 1, 2, tzinfo=UTC)
    session.add(older_edge)
    session.add(newer_edge)
    session.flush()
    assert lineage_label(session, child["id"]) == "Higher.Child"

    same_time = datetime(2026, 1, 1, tzinfo=UTC)
    older_edge.created_at = same_time
    newer_edge.created_at = same_time
    session.add(older_edge)
    session.add(newer_edge)
    session.flush()

    assert lower_accession["accession"] < higher_accession["accession"]
    assert lineage_label(session, child["id"]) == "Lower.Child"


def test_lineage_label_name_length_boundaries(session: Session) -> None:
    one_character = create_entity(session, "project", {"name": "A"})
    twelve_characters = create_entity(session, "project", {"name": "ABCDEFGHIJKL"})
    empty = create_entity(session, "project", {"name": ""})
    thirteen_characters = create_entity(session, "project", {"name": "ABCDEFGHIJKLM"})

    assert lineage_label(session, one_character["id"]) == "A"
    assert lineage_label(session, twelve_characters["id"]) == "ABCDEFGHIJKL"
    assert lineage_label(session, empty["id"]) == empty["accession"]
    assert (
        lineage_label(session, thirteen_characters["id"])
        == thirteen_characters["accession"]
    )


def test_lineage_label_stops_before_repeating_a_cycle(session: Session) -> None:
    """add_edge now rejects new structural cycles, but legacy rows may still
    contain one; the label walk must not loop on them."""
    from labcore.models.edges import ProvenanceEdge

    first = create_entity(session, "device", {"name": "First"})
    second = create_entity(session, "device", {"name": "Second"})
    session.add(
        ProvenanceEdge(
            src_id=first["id"], dst_id=second["id"], relation="derived_from"
        )
    )
    session.add(
        ProvenanceEdge(
            src_id=second["id"], dst_id=first["id"], relation="derived_from"
        )
    )
    session.flush()

    assert lineage_label(session, first["id"]) == "Second.First"


def test_lineage_label_caps_traversal_at_depth_32(session: Session) -> None:
    entities = [
        create_entity(session, "project", {"name": f"N{index:02d}"})
        for index in range(34)
    ]
    for parent, child in zip(entities, entities[1:]):
        add_edge(
            session,
            child["id"],
            RelationType.DERIVED_FROM,
            parent["id"],
        )

    assert lineage_label(session, entities[-1]["id"]) == ".".join(
        f"N{index:02d}" for index in range(1, 34)
    )


def test_lineage_label_endpoint(client: TestClient) -> None:
    root = client.post("/api/wafer", json={"name": "Root"}).json()
    child = client.post("/api/device", json={"name": "Child"}).json()
    edge_response = client.post(
        "/api/edges",
        json={
            "src_id": child["id"],
            "relation": "derived_from",
            "dst_id": root["id"],
        },
    )
    assert edge_response.status_code == 201

    response = client.get(f"/api/entities/{child['id']}/label")

    assert response.status_code == 200
    assert response.json() == {"label": "Root.Child"}


def test_lineage_label_endpoint_returns_404_for_unknown_entity(
    client: TestClient,
) -> None:
    response = client.get(f"/api/entities/{uuid.uuid4()}/label")

    assert response.status_code == 404
