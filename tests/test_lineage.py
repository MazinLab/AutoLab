import pytest
from sqlmodel import Session

from labcore.lineage import add_edge, lineage
from labcore.models.edges import RelationType
from labcore.service import create_entity


def _chain(session: Session) -> dict[str, dict]:
    """design ← wafer ← device, device MEASURED_IN cooldown."""
    design = create_entity(session, "design", {"name": "rev A"})
    wafer = create_entity(session, "wafer", {"name": "W1"})
    device = create_entity(session, "device", {"name": "dev 1"})
    cooldown = create_entity(session, "experiment_setup", {"name": "CD 1"})
    add_edge(session, wafer["id"], RelationType.DERIVED_FROM, design["id"])
    add_edge(session, device["id"], RelationType.DERIVED_FROM, wafer["id"])
    add_edge(session, device["id"], RelationType.MEASURED_IN, cooldown["id"])
    return {"design": design, "wafer": wafer,
            "device": device, "experiment_setup": cooldown}


def test_lineage_up_walks_ancestors(session: Session) -> None:
    e = _chain(session)
    up = lineage(session, e["device"]["id"], direction="up", depth=10)
    accessions = {r["accession"] for r in up}
    assert e["wafer"]["accession"] in accessions
    assert e["design"]["accession"] in accessions
    # measured_in is not structural: the cooldown is NOT an ancestor
    assert e["experiment_setup"]["accession"] not in accessions
    depths = {r["accession"]: r["depth"] for r in up}
    assert depths[e["wafer"]["accession"]] == 1
    assert depths[e["design"]["accession"]] == 2


def test_lineage_with_explicit_relations(session: Session) -> None:
    e = _chain(session)
    up = lineage(
        session, e["device"]["id"], direction="up", depth=10,
        relations={"measured_in"},
    )
    assert {r["accession"] for r in up} == {e["experiment_setup"]["accession"]}


def test_duplicate_edge_is_idempotent(session: Session) -> None:
    e = _chain(session)
    first = add_edge(
        session, e["device"]["id"], RelationType.MOUNTED_IN, e["experiment_setup"]["id"]
    )
    second = add_edge(
        session, e["device"]["id"], RelationType.MOUNTED_IN, e["experiment_setup"]["id"]
    )
    assert second.id == first.id


def test_lineage_down_walks_descendants(session: Session) -> None:
    e = _chain(session)
    down = lineage(session, e["design"]["id"], direction="down", depth=10)
    accessions = {r["accession"] for r in down}
    assert e["wafer"]["accession"] in accessions
    assert e["device"]["accession"] in accessions


def test_depth_limits_traversal(session: Session) -> None:
    e = _chain(session)
    up = lineage(session, e["device"]["id"], direction="up", depth=1)
    assert {r["depth"] for r in up} == {1}


def test_add_edge_conflict_with_row_outside_session_state(
    session: Session,
) -> None:
    """A concurrent writer's row (unknown to this session's ORM state) must
    make add_edge return the existing edge without raising or logging an
    event — the insert must be conflict-safe, not check-then-insert."""
    from sqlalchemy import insert

    from labcore.events import list_events
    from labcore.models.base import utcnow, uuid7
    from labcore.models.edges import ProvenanceEdge

    e = _chain(session)
    theirs = uuid7()
    session.execute(
        insert(ProvenanceEdge).values(
            id=theirs,
            src_id=e["device"]["id"],
            dst_id=e["experiment_setup"]["id"],
            relation=str(RelationType.MOUNTED_IN),
            created_at=utcnow(),
        )
    )
    events_before = len(list_events(session, limit=1000))
    edge = add_edge(
        session, e["device"]["id"], RelationType.MOUNTED_IN, e["experiment_setup"]["id"]
    )
    assert edge.id == theirs
    assert len(list_events(session, limit=1000)) == events_before


def test_add_edge_records_event_only_for_new_edge(session: Session) -> None:
    from labcore.events import list_events

    e = _chain(session)
    before = len(list_events(session, limit=1000))
    add_edge(session, e["device"]["id"], RelationType.PART_OF, e["wafer"]["id"])
    assert len(list_events(session, limit=1000)) == before + 1
    add_edge(session, e["device"]["id"], RelationType.PART_OF, e["wafer"]["id"])
    assert len(list_events(session, limit=1000)) == before + 1


def test_add_edge_rejects_unregistered_and_self(session: Session) -> None:
    e = _chain(session)
    import uuid
    with pytest.raises(ValueError):
        add_edge(session, uuid.uuid4(), RelationType.DERIVED_FROM,
                 e["wafer"]["id"])
    with pytest.raises(ValueError):
        add_edge(session, e["wafer"]["id"], RelationType.DERIVED_FROM,
                 e["wafer"]["id"])


def test_add_edge_rejects_direct_structural_cycle(session: Session) -> None:
    a = create_entity(session, "wafer", {"name": "A"})
    b = create_entity(session, "device", {"name": "B"})
    add_edge(session, b["id"], RelationType.DERIVED_FROM, a["id"])

    with pytest.raises(ValueError, match="cycle"):
        add_edge(session, a["id"], RelationType.DERIVED_FROM, b["id"])


def test_add_edge_rejects_transitive_structural_cycle(session: Session) -> None:
    a = create_entity(session, "design", {"name": "A"})
    b = create_entity(session, "wafer", {"name": "B"})
    c = create_entity(session, "device", {"name": "C"})
    add_edge(session, b["id"], RelationType.DERIVED_FROM, a["id"])
    add_edge(session, c["id"], RelationType.DERIVED_FROM, b["id"])

    with pytest.raises(ValueError, match="cycle"):
        add_edge(session, a["id"], RelationType.DERIVED_FROM, c["id"])


def test_mutual_non_structural_edges_are_allowed(session: Session) -> None:
    a = create_entity(session, "note", {"name": "A"})
    b = create_entity(session, "note", {"name": "B"})

    add_edge(session, a["id"], RelationType.REFERS_TO, b["id"])
    add_edge(session, b["id"], RelationType.REFERS_TO, a["id"])


def test_lineage_with_legacy_cycle_excludes_root_and_terminates(
    session: Session,
) -> None:
    """Cycles that predate the acyclicity check must not make an entity its
    own ancestor or hang traversal."""
    from labcore.models.edges import ProvenanceEdge

    a = create_entity(session, "wafer", {"name": "A"})
    b = create_entity(session, "device", {"name": "B"})
    session.add(
        ProvenanceEdge(
            src_id=a["id"], dst_id=b["id"], relation="derived_from"
        )
    )
    session.add(
        ProvenanceEdge(
            src_id=b["id"], dst_id=a["id"], relation="derived_from"
        )
    )
    session.flush()

    ancestors = lineage(session, a["id"], direction="up", depth=10)
    ancestor_ids = {node["id"] for node in ancestors}
    assert a["id"] not in ancestor_ids
    assert ancestor_ids == {b["id"]}
