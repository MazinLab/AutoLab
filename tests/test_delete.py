import uuid

import pytest
from sqlmodel import Session, select

from labcore.lineage import add_edge, lineage, remove_edge
from labcore.models.base import EntityRegistry
from labcore.models.edges import ProvenanceEdge, RelationType
from labcore.models.events import Event
from labcore.service import create_entity, delete_entity


@pytest.fixture()
def wafer_with_device(session: Session) -> tuple[dict, dict]:
    wafer = create_entity(session, "wafer", {"name": "W1"})
    device = create_entity(session, "device", {"name": "W1-C1"})
    add_edge(
        session, device["id"], RelationType.DERIVED_FROM, wafer["id"]
    )
    return wafer, device


def test_delete_removes_entity_edges_and_leaves_tombstone_event(
    session: Session, wafer_with_device: tuple[dict, dict]
) -> None:
    wafer, device = wafer_with_device

    snapshot = delete_entity(session, device["id"])

    assert snapshot is not None
    assert snapshot["accession"] == device["accession"]
    assert session.get(EntityRegistry, device["id"]) is None
    assert (
        session.exec(
            select(ProvenanceEdge).where(
                ProvenanceEdge.src_id == device["id"]
            )
        ).first()
        is None
    )
    assert lineage(session, wafer["id"], direction="down") == []

    tombstone = session.exec(
        select(Event).where(Event.action == "deleted")
    ).one()
    assert tombstone.entity_id == device["id"]
    assert tombstone.payload["accession"] == device["accession"]
    assert tombstone.payload["entity_type"] == "device"
    assert tombstone.payload["removed_edges"] == [
        {
            "src_id": str(device["id"]),
            "relation": "derived_from",
            "dst_id": str(wafer["id"]),
        }
    ]


def test_delete_unknown_or_wrong_type_is_a_noop(session: Session) -> None:
    wafer = create_entity(session, "wafer", {"name": "W1"})

    assert delete_entity(session, uuid.uuid4()) is None
    assert delete_entity(session, wafer["id"], expect_type="device") is None
    assert session.get(EntityRegistry, wafer["id"]) is not None


def test_delete_actor_with_history_is_refused(session: Session) -> None:
    person = create_entity(session, "person", {"name": "Alice"})
    create_entity(session, "wafer", {"name": "W1"}, actor_id=person["id"])

    with pytest.raises(ValueError, match="actor"):
        delete_entity(session, person["id"])
    assert session.get(EntityRegistry, person["id"]) is not None


def test_delete_fresh_actor_succeeds(session: Session) -> None:
    person = create_entity(session, "person", {"name": "Typo Person"})

    assert delete_entity(session, person["id"]) is not None
    assert session.get(EntityRegistry, person["id"]) is None


def test_remove_edge_deletes_row_and_records_unlinked(
    session: Session, wafer_with_device: tuple[dict, dict]
) -> None:
    wafer, device = wafer_with_device

    removed = remove_edge(
        session, device["id"], RelationType.DERIVED_FROM, wafer["id"]
    )

    assert removed is True
    assert lineage(session, device["id"], direction="up") == []
    unlinked = session.exec(
        select(Event).where(Event.action == "unlinked")
    ).one()
    assert unlinked.entity_id == device["id"]
    assert unlinked.payload == {
        "relation": "derived_from",
        "dst_id": str(wafer["id"]),
    }


def test_remove_missing_edge_returns_false_and_records_nothing(
    session: Session, wafer_with_device: tuple[dict, dict]
) -> None:
    wafer, device = wafer_with_device

    removed = remove_edge(
        session, wafer["id"], RelationType.DERIVED_FROM, device["id"]
    )

    assert removed is False
    assert (
        session.exec(
            select(Event).where(Event.action == "unlinked")
        ).first()
        is None
    )


def test_api_delete_entity(client, wafer_payload: None = None) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()

    response = client.delete(f"/api/wafer/{wafer['id']}")

    assert response.status_code == 204
    assert client.get(f"/api/wafer/{wafer['id']}").status_code == 404


def test_api_delete_wrong_type_404s_without_deleting(client) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()

    assert client.delete(f"/api/device/{wafer['id']}").status_code == 404
    assert client.get(f"/api/wafer/{wafer['id']}").status_code == 200


def test_api_delete_actor_with_history_409s(client) -> None:
    person = client.post("/api/person", json={"name": "Alice"}).json()
    client.post(
        "/api/wafer",
        json={"name": "W1"},
        headers={"X-Actor-Id": person["id"]},
    )

    response = client.delete(f"/api/person/{person['id']}")

    assert response.status_code == 409


def test_api_delete_edge(client) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()
    device = client.post("/api/device", json={"name": "W1-C1"}).json()
    client.post(
        "/api/edges",
        json={
            "src_id": device["id"],
            "relation": "derived_from",
            "dst_id": wafer["id"],
        },
    )

    params = {
        "src_id": device["id"],
        "relation": "derived_from",
        "dst_id": wafer["id"],
    }
    assert client.delete("/api/edges", params=params).status_code == 204
    # Idempotent from the client's view apart from the status: already gone.
    assert client.delete("/api/edges", params=params).status_code == 404
    assert (
        client.get(f"/api/entities/{device['id']}/lineage").json() == []
    )
