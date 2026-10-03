import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import select

from app.api.entities import ActorDep, SessionDep
from labcore.events import list_events
from labcore.lineage import add_edge, lineage, lineage_graph, remove_edge
from labcore.lineage_label import lineage_label
from labcore.models.base import EntityRegistry
from labcore.models.edges import ProvenanceEdge, RelationType
from labcore.models.entities import FabStep
from labcore.service import resolve_registry

router = APIRouter(prefix="/api")


class EdgeIn(BaseModel):
    src_id: uuid.UUID
    relation: RelationType
    dst_id: uuid.UUID


@router.post("/edges", status_code=201)
def create_edge(body: EdgeIn, session: SessionDep, actor: ActorDep) -> dict:
    try:
        edge = add_edge(
            session, body.src_id, body.relation, body.dst_id, actor_id=actor
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return {"id": edge.id}


@router.delete("/edges", status_code=204)
def delete_edge(
    src_id: uuid.UUID,
    relation: RelationType,
    dst_id: uuid.UUID,
    session: SessionDep,
    actor: ActorDep,
) -> None:
    """Retract a mistaken edge; the feed records "unlinked"."""
    try:
        removed = remove_edge(session, src_id, relation, dst_id, actor_id=actor)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    if not removed:
        raise HTTPException(404, "no such edge")


def _parse_relations(raw: str | None) -> set[str] | None:
    """Parse a comma-separated ``relations`` query value into a validated set.

    ``None`` (param absent) preserves the default structural-relation behavior;
    unknown relation names fail fast with 422 so a typo can never silently
    traverse zero edges.
    """
    if raw is None:
        return None
    wanted = {item.strip() for item in raw.split(",") if item.strip()}
    if not wanted:
        return None
    unknown = wanted - {relation.value for relation in RelationType}
    if unknown:
        raise HTTPException(422, f"unknown relation(s): {', '.join(sorted(unknown))}")
    return wanted


def _decode_cursor(after: str) -> tuple[datetime, uuid.UUID]:
    try:
        at_raw, id_raw = after.split("|", 1)
        at = datetime.fromisoformat(at_raw)
        event_id = uuid.UUID(id_raw)
    except ValueError as exc:
        raise HTTPException(422, f"malformed cursor: {after!r}") from exc
    if at.tzinfo is None or at.utcoffset() is None:
        raise HTTPException(
            422, f"cursor timestamp must include a UTC offset: {after!r}"
        )
    return at.astimezone(UTC), event_id


def _encode_cursor(at: datetime, event_id: uuid.UUID) -> str:
    return f"{at.isoformat()}|{event_id}"


def _lineage_both_directions(
    session: SessionDep,
    entity_id: uuid.UUID,
    depth: int,
    relations: set[str] | None,
    graph: bool,
) -> list[dict] | dict[str, list[dict]]:
    lineage_fn = lineage_graph if graph else lineage
    upstream = lineage_fn(
        session, entity_id, direction="up", depth=depth, relations=relations
    )
    downstream = lineage_fn(
        session, entity_id, direction="down", depth=depth, relations=relations
    )
    upstream_nodes = upstream["nodes"] if graph else upstream
    downstream_nodes = downstream["nodes"] if graph else downstream
    nodes_by_id: dict[uuid.UUID, dict] = {}
    for node in [*upstream_nodes, *downstream_nodes]:
        current = nodes_by_id.get(node["id"])
        if current is None or node["depth"] < current["depth"]:
            nodes_by_id[node["id"]] = node
    nodes = sorted(
        nodes_by_id.values(),
        key=lambda node: (node["depth"], node["accession"], node["id"]),
    )
    if not graph:
        return nodes

    edges = {
        (edge["src_id"], edge["relation"], edge["dst_id"]): edge
        for edge in [*upstream["edges"], *downstream["edges"]]
    }
    return {"nodes": nodes, "edges": list(edges.values())}


@router.get("/entities/{entity_id}/lineage")
def get_lineage(
    entity_id: uuid.UUID,
    session: SessionDep,
    direction: str = "up",
    depth: Annotated[int, Query(ge=0, le=64)] = 5,
    graph: bool = False,
    relations: str | None = None,
    hydrate: bool = False,
) -> list[dict] | dict[str, list[dict]]:
    wanted = _parse_relations(relations)
    try:
        if direction == "both":
            result = _lineage_both_directions(
                session,
                entity_id,
                depth=depth,
                relations=wanted,
                graph=graph,
            )
        elif graph:
            result = lineage_graph(
                session,
                entity_id,
                direction=direction,
                depth=depth,
                relations=wanted,
            )
        else:
            result = lineage(
                session,
                entity_id,
                direction=direction,
                depth=depth,
                relations=wanted,
            )
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    if hydrate:
        _hydrate_names(session, result)
    return result


def _hydrate_names(session, result: list[dict] | dict) -> None:
    """Attach display names so clients skip one getEntity per node."""
    from app.api.meta import _entity_summaries

    nodes = result["nodes"] if isinstance(result, dict) else result
    summaries = _entity_summaries(session, {node["id"] for node in nodes})
    for node in nodes:
        summary = summaries.get(node["id"])
        node["name"] = summary.get("name", "") if summary else ""


@router.get("/entities/{entity_id}/fab_flow")
def get_fab_flow(entity_id: uuid.UUID, session: SessionDep) -> dict:
    """The wafer's process history: its fab steps in order, resolved.

    A step links to its wafer and its recipe with the same relation
    (refers_to) and to the machine with performed_on, so reading the flow
    from raw lineage would cost one request per step and still leave the
    client to tell recipe from wafer. Resolving it here keeps the wafer page
    to a single call.
    """
    from app.api.meta import _entity_summaries

    if resolve_registry(session, entity_id) is None:
        raise HTTPException(404, "entity not found")

    step_rows = session.exec(
        select(FabStep, EntityRegistry)
        .join(EntityRegistry, EntityRegistry.id == FabStep.id)
        .join(ProvenanceEdge, ProvenanceEdge.src_id == FabStep.id)
        .where(
            ProvenanceEdge.dst_id == entity_id,
            ProvenanceEdge.relation == RelationType.REFERS_TO,
        )
    ).all()
    if not step_rows:
        return {"steps": []}

    step_ids = {step.id for step, _ in step_rows}
    # Every outbound link a step can carry: refers_to reaches both the wafer
    # and the recipe, performed_on reaches the machine.
    edges = session.exec(
        select(ProvenanceEdge).where(
            ProvenanceEdge.src_id.in_(step_ids),
            ProvenanceEdge.relation.in_(
                [RelationType.REFERS_TO, RelationType.PERFORMED_ON]
            ),
        )
    ).all()
    summaries = _entity_summaries(session, {edge.dst_id for edge in edges})
    linked: dict[uuid.UUID, dict[str, dict]] = {}
    for edge in edges:
        summary = summaries.get(edge.dst_id)
        if summary is None or summary["entity_type"] not in {
            "fab_recipe",
            "instrument",
        }:
            continue
        linked.setdefault(edge.src_id, {})[summary["entity_type"]] = summary

    # step_index is the crew's ordering; creation time breaks ties so a
    # re-run of the same index keeps a stable, meaningful position.
    step_rows.sort(key=lambda row: (row[0].step_index, row[1].created_at))
    return {
        "steps": [
            {
                "id": step.id,
                "accession": registry.accession,
                "step_index": step.step_index,
                "name": step.name,
                "body": step.body,
                "created_at": registry.created_at,
                "recipe": linked.get(step.id, {}).get("fab_recipe"),
                "instrument": linked.get(step.id, {}).get("instrument"),
            }
            for step, registry in step_rows
        ]
    }


@router.get("/entities/{entity_id}/registry")
def get_registry(entity_id: uuid.UUID, session: SessionDep) -> dict:
    registry = resolve_registry(session, entity_id)
    if registry is None:
        raise HTTPException(404, "entity not found")
    return registry.model_dump()


@router.get("/entities/{entity_id}/events")
def get_entity_events(
    entity_id: uuid.UUID,
    session: SessionDep,
    after: str | None = None,
    limit: Annotated[int, Query(ge=0, le=100)] = 100,
) -> dict:
    if resolve_registry(session, entity_id) is None:
        raise HTTPException(404, "entity not found")
    cursor = _decode_cursor(after) if after else None
    rows = list_events(
        session,
        after=cursor,
        limit=limit,
        entity_id=entity_id,
    )
    next_cursor = _encode_cursor(rows[-1]["at"], rows[-1]["id"]) if rows else None
    return {"events": rows, "next_cursor": next_cursor}


@router.get("/entities/{entity_id}/label")
def get_lineage_label(entity_id: uuid.UUID, session: SessionDep) -> dict[str, str]:
    try:
        return {"label": lineage_label(session, entity_id)}
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
