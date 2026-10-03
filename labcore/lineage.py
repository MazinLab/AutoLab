import uuid

from sqlalchemy import func, literal, select as sa_select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlmodel import Session, select

from labcore.events import record_event
from labcore.models.base import EntityRegistry, utcnow, uuid7
from labcore.models.edges import ProvenanceEdge, RelationType
from labcore.service import require_actor

_DIALECT_INSERT = {"postgresql": pg_insert, "sqlite": sqlite_insert}

STRUCTURAL_RELATIONS: set[str] = {
    RelationType.DERIVED_FROM,
    RelationType.PART_OF,
    RelationType.SUPERSEDES,
}

# Traversal budget for the acyclicity check on structural edge inserts; far
# deeper than any real lineage chain, and it also bounds the work if legacy
# data already contains a cycle.
_CYCLE_CHECK_DEPTH = 1000


def add_edge(
    session: Session,
    src_id: uuid.UUID,
    relation: RelationType,
    dst_id: uuid.UUID,
    actor_id: uuid.UUID | None = None,
) -> ProvenanceEdge:
    if src_id == dst_id:
        raise ValueError("edge endpoints must differ")
    for end in (src_id, dst_id):
        if session.get(EntityRegistry, end) is None:
            raise ValueError(f"unregistered entity: {end}")
    require_actor(session, actor_id)
    if str(relation) in STRUCTURAL_RELATIONS:
        # Structural relations define ancestry, which must stay acyclic: a
        # cycle makes an entity its own ancestor and poisons every lineage
        # query that touches it. Reject the edge before it exists.
        #
        # Under READ COMMITTED two concurrent inserts (A->B and B->A) can
        # each pass this check against a snapshot missing the other's edge
        # and commit a persistent cycle. A transaction-scoped advisory lock
        # serializes structural-edge writers on Postgres; SQLite's single
        # writer needs nothing.
        if session.get_bind().dialect.name == "postgresql":
            session.execute(text("SELECT pg_advisory_xact_lock(747470001)"))
        ancestors = lineage(
            session, dst_id, direction="up", depth=_CYCLE_CHECK_DEPTH
        )
        if any(node["id"] == src_id for node in ancestors):
            raise ValueError(
                f"structural edge would create a cycle: {dst_id} already "
                f"descends from {src_id}"
            )
    # Atomic idempotency: a single INSERT .. ON CONFLICT DO NOTHING closes the
    # race where two writers pass a check-then-insert existence test and one
    # dies on the unique constraint. RETURNING tells us whether OUR row won.
    insert_stmt = _DIALECT_INSERT[session.get_bind().dialect.name](ProvenanceEdge)
    inserted_id = session.execute(
        insert_stmt.values(
            id=uuid7(),
            src_id=src_id,
            dst_id=dst_id,
            relation=str(relation),
            created_at=utcnow(),
        )
        .on_conflict_do_nothing(index_elements=["src_id", "dst_id", "relation"])
        .returning(ProvenanceEdge.__table__.c.id)
    ).scalar_one_or_none()
    if inserted_id is None:
        # idempotent replay (or lost race): return the existing edge, no event
        return session.exec(
            select(ProvenanceEdge).where(
                ProvenanceEdge.src_id == src_id,
                ProvenanceEdge.dst_id == dst_id,
                ProvenanceEdge.relation == str(relation),
            )
        ).one()
    record_event(
        session,
        "linked",
        src_id,
        actor_id=actor_id,
        payload={"relation": str(relation), "dst_id": str(dst_id)},
    )
    session.flush()
    edge = session.get(ProvenanceEdge, inserted_id)
    assert edge is not None  # just inserted in this transaction
    return edge


def remove_edge(
    session: Session,
    src_id: uuid.UUID,
    relation: RelationType,
    dst_id: uuid.UUID,
    actor_id: uuid.UUID | None = None,
) -> bool:
    """Retract a mistaken provenance edge; the "unlinked" event is the record."""
    require_actor(session, actor_id)
    edge = session.exec(
        select(ProvenanceEdge).where(
            ProvenanceEdge.src_id == src_id,
            ProvenanceEdge.dst_id == dst_id,
            ProvenanceEdge.relation == str(relation),
        )
    ).one_or_none()
    if edge is None:
        return False
    session.delete(edge)
    record_event(
        session,
        "unlinked",
        src_id,
        actor_id=actor_id,
        payload={"relation": str(relation), "dst_id": str(dst_id)},
    )
    session.flush()
    return True


def lineage(
    session: Session,
    entity_id: uuid.UUID,
    direction: str = "up",
    depth: int = 5,
    relations: set[str] | None = None,
) -> list[dict]:
    if direction not in ("up", "down"):
        raise ValueError("direction must be 'up' or 'down'")
    if depth < 0:
        raise ValueError("depth must be non-negative")
    if depth == 0:
        return []
    wanted = {str(r) for r in (relations or STRUCTURAL_RELATIONS)}
    edges = ProvenanceEdge.__table__
    follow, other = (
        (edges.c.src_id, edges.c.dst_id)
        if direction == "up"
        else (edges.c.dst_id, edges.c.src_id)
    )
    base = (
        sa_select(other.label("eid"), literal(1).label("depth"))
        .where(follow == entity_id, edges.c.relation.in_(wanted))
        .cte(recursive=True)
    )
    step = sa_select(other, (base.c.depth + 1).label("depth")).where(
        follow == base.c.eid,
        edges.c.relation.in_(wanted),
        base.c.depth < depth,
    )
    cte = base.union(step)
    reached = (
        sa_select(cte.c.eid, func.min(cte.c.depth).label("depth"))
        # A cycle can lead traversal back to the root; an entity is never
        # part of its own lineage.
        .where(cte.c.eid != entity_id)
        .group_by(cte.c.eid)
        .subquery()
    )
    rows = session.exec(
        select(EntityRegistry, reached.c.depth)
        .join(reached, EntityRegistry.id == reached.c.eid)
        .order_by(reached.c.depth)
    ).all()
    return [
        {
            "id": reg.id,
            "entity_type": reg.entity_type,
            "accession": reg.accession,
            "depth": d,
        }
        for reg, d in rows
    ]


def lineage_graph(
    session: Session,
    entity_id: uuid.UUID,
    direction: str = "up",
    depth: int = 5,
    relations: set[str] | None = None,
) -> dict[str, list[dict]]:
    nodes = lineage(
        session,
        entity_id,
        direction=direction,
        depth=depth,
        relations=relations,
    )
    reached_ids = {node["id"] for node in nodes}
    if not reached_ids:
        return {"nodes": nodes, "edges": []}

    wanted = {str(relation) for relation in (relations or STRUCTURAL_RELATIONS)}
    displayed_ids = reached_ids | {entity_id}
    statement = select(ProvenanceEdge).where(
        ProvenanceEdge.relation.in_(wanted),
        ProvenanceEdge.src_id.in_(displayed_ids),
        ProvenanceEdge.dst_id.in_(displayed_ids),
    )

    selected_edges = session.exec(
        statement.order_by(
            ProvenanceEdge.src_id,
            ProvenanceEdge.dst_id,
            ProvenanceEdge.relation,
        )
    ).all()
    edges: list[dict] = []
    seen: set[tuple[uuid.UUID, uuid.UUID, str]] = set()
    for edge in selected_edges:
        key = (edge.src_id, edge.dst_id, edge.relation)
        if key in seen:
            continue
        seen.add(key)
        edges.append(
            {
                "src_id": edge.src_id,
                "dst_id": edge.dst_id,
                "relation": edge.relation,
            }
        )
    return {"nodes": nodes, "edges": edges}
