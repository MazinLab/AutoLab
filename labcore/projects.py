"""Project goals, milestones, and the progress report.

Items are checklist rows owned by a project, not entities: no accession,
no lineage. Every write records an event against the project so the
project's history and the global feed show it. Functions flush, never
commit — the caller owns the transaction.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlmodel import Session, select

from labcore.events import record_event
from labcore.models.base import EntityRegistry, utcnow
from labcore.models.edges import ProvenanceEdge, RelationType
from labcore.models.entities import AnalysisRun, Note, Wafer
from labcore.models.events import Event
from labcore.models.project_items import ProjectItem, ProjectItemKind
from labcore.service import PROJECT_MEMBER_TYPES, get_entity, require_actor


class ProjectNotFoundError(LookupError):
    pass


class ProjectItemNotFoundError(LookupError):
    pass


# Report work blocks, in display order. Direct blocks filter on the
# member table's project_id; indirect blocks follow a refers_to edge to a
# wafer in the project (fab steps, fab notes, and wafer measurements point
# at their wafer).
DIRECT_WORK: tuple[tuple[str, str, str | None], ...] = (
    # (report key, entity type, note template or None)
    ("wafer", "wafer", None),
    ("device", "device", None),
    ("experiment_setup", "experiment_setup", None),
    ("experiment", "note", "Experiment"),
    ("analysis_run", "analysis_run", None),
    ("design", "design", None),
    ("fab_recipe", "fab_recipe", None),
    ("substrate_batch", "substrate_batch", None),
    ("software", "software", None),
)
INDIRECT_WORK: tuple[tuple[str, str, str | None], ...] = (
    ("fab_step", "fab_step", None),
    ("fab_note", "note", "Fab Note"),
    ("measurement_run", "measurement_run", None),
)


def _result_summary_ids(session: Session, project_id: uuid.UUID) -> list[uuid.UUID]:
    """Summaries joined by at least one of the project's analyses, newest first."""
    analyses = select(AnalysisRun.id).where(AnalysisRun.project_id == project_id)
    stmt = (
        select(EntityRegistry.id, EntityRegistry.created_at)
        .join(ProvenanceEdge, ProvenanceEdge.dst_id == EntityRegistry.id)  # type: ignore[arg-type]
        .where(
            EntityRegistry.entity_type == "result_summary",
            ProvenanceEdge.relation == RelationType.REFERS_TO,
            ProvenanceEdge.src_id.in_(analyses),  # type: ignore[attr-defined]
        )
        .order_by(EntityRegistry.created_at.desc(), EntityRegistry.id.desc())  # type: ignore[attr-defined]
        .distinct()
    )
    return [row[0] for row in session.exec(stmt).all()]


def _require_project(session: Session, project_id: uuid.UUID) -> EntityRegistry:
    reg = session.get(EntityRegistry, project_id)
    if reg is None or reg.entity_type != "project":
        raise ProjectNotFoundError(str(project_id))
    return reg


def _require_item(
    session: Session, item_id: uuid.UUID, project_id: uuid.UUID | None = None
) -> ProjectItem:
    item = session.get(ProjectItem, item_id)
    if item is None or (project_id is not None and item.project_id != project_id):
        raise ProjectItemNotFoundError(str(item_id))
    return item


def _validate_kind(kind: str) -> str:
    try:
        return ProjectItemKind(kind).value
    except ValueError as exc:
        raise ValueError(f"invalid item kind: {kind}") from exc


def _validate_title(title: object) -> str:
    if not isinstance(title, str) or not title.strip():
        raise ValueError("title must be a non-empty string")
    return title.strip()


def _validate_target_date(kind: str, value: object) -> date | None:
    if value is None or value == "":
        return None
    if kind == ProjectItemKind.GOAL:
        raise ValueError("goals do not take a target date")
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError(f"invalid target_date: {value}") from exc
    raise ValueError(f"invalid target_date: {value!r}")


def item_to_dict(item: ProjectItem) -> dict:
    return item.model_dump()


def _items_of_kind(
    session: Session, project_id: uuid.UUID, kind: str
) -> list[ProjectItem]:
    return list(
        session.exec(
            select(ProjectItem)
            .where(ProjectItem.project_id == project_id, ProjectItem.kind == kind)
            .order_by(ProjectItem.position, ProjectItem.created_at)  # type: ignore[arg-type]
        ).all()
    )


def list_items(session: Session, project_id: uuid.UUID) -> dict[str, list[dict]]:
    _require_project(session, project_id)
    return {
        "goals": [item_to_dict(i) for i in _items_of_kind(session, project_id, "goal")],
        "milestones": [
            item_to_dict(i) for i in _items_of_kind(session, project_id, "milestone")
        ],
    }


def create_item(
    session: Session,
    project_id: uuid.UUID,
    kind: str,
    title: str,
    *,
    target_date: object = None,
    actor_id: uuid.UUID | None = None,
) -> dict:
    _require_project(session, project_id)
    require_actor(session, actor_id)
    kind = _validate_kind(kind)
    title = _validate_title(title)
    target = _validate_target_date(kind, target_date)
    siblings = _items_of_kind(session, project_id, kind)
    position = max((s.position for s in siblings), default=-1) + 1
    item = ProjectItem(
        project_id=project_id,
        kind=kind,
        title=title,
        position=position,
        target_date=target,
        created_by_id=actor_id,
    )
    session.add(item)
    session.flush()
    record_event(
        session,
        "project_item.created",
        project_id,
        actor_id=actor_id,
        payload={
            "item_id": str(item.id),
            "kind": kind,
            "title": title,
            "target_date": target.isoformat() if target else None,
        },
    )
    session.flush()
    return item_to_dict(item)


def update_item(
    session: Session,
    item_id: uuid.UUID,
    patch: dict,
    *,
    actor_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
) -> dict:
    """Patch semantics: an absent key is preserved, ``target_date: null``
    clears the date, ``done`` marks done or reopens (idempotent)."""
    item = _require_item(session, item_id, project_id)
    require_actor(session, actor_id)
    unknown = set(patch) - {"title", "target_date", "done"}
    if unknown:
        raise ValueError(f"unknown item fields: {sorted(unknown)}")
    changes: dict = {}
    if "title" in patch:
        title = _validate_title(patch["title"])
        if title != item.title:
            item.title = title
            changes["title"] = title
    if "target_date" in patch:
        target = _validate_target_date(item.kind, patch["target_date"])
        if target != item.target_date:
            item.target_date = target
            changes["target_date"] = target.isoformat() if target else None
    if changes:
        session.add(item)
        record_event(
            session,
            "project_item.updated",
            item.project_id,
            actor_id=actor_id,
            payload={"item_id": str(item.id), "kind": item.kind, "patch": changes},
        )
    if "done" in patch:
        if not isinstance(patch["done"], bool):
            raise ValueError("done must be true or false")
        _set_done(session, item, patch["done"], actor_id)
    session.flush()
    return item_to_dict(item)


def _set_done(
    session: Session, item: ProjectItem, done: bool, actor_id: uuid.UUID | None
) -> None:
    if done == (item.done_at is not None):
        return  # idempotent: keep the original actor and time, no event
    if done:
        item.done_at = utcnow()
        item.done_by_id = actor_id
        action = "project_item.done"
    else:
        item.done_at = None
        item.done_by_id = None
        action = "project_item.reopened"
    session.add(item)
    record_event(
        session,
        action,
        item.project_id,
        actor_id=actor_id,
        payload={"item_id": str(item.id), "kind": item.kind, "title": item.title},
    )


def set_item_done(
    session: Session,
    item_id: uuid.UUID,
    done: bool,
    *,
    actor_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
) -> dict:
    item = _require_item(session, item_id, project_id)
    require_actor(session, actor_id)
    _set_done(session, item, done, actor_id)
    session.flush()
    return item_to_dict(item)


def reorder_items(
    session: Session,
    project_id: uuid.UUID,
    kind: str,
    item_ids: list[uuid.UUID],
    *,
    actor_id: uuid.UUID | None = None,
) -> list[dict]:
    """The client sends the complete order; anything else is rejected so a
    stale client cannot drop items."""
    _require_project(session, project_id)
    require_actor(session, actor_id)
    kind = _validate_kind(kind)
    current = {item.id: item for item in _items_of_kind(session, project_id, kind)}
    if len(set(item_ids)) != len(item_ids):
        raise ValueError("item_ids contains duplicates")
    if set(item_ids) != set(current):
        raise ValueError("item_ids must list every current item of that kind once")
    for position, item_id in enumerate(item_ids):
        current[item_id].position = position
        session.add(current[item_id])
    record_event(
        session,
        "project_item.reordered",
        project_id,
        actor_id=actor_id,
        payload={"kind": kind, "item_ids": [str(i) for i in item_ids]},
    )
    session.flush()
    return [item_to_dict(i) for i in _items_of_kind(session, project_id, kind)]


def delete_item(
    session: Session,
    item_id: uuid.UUID,
    *,
    actor_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
) -> None:
    item = _require_item(session, item_id, project_id)
    require_actor(session, actor_id)
    record_event(
        session,
        "project_item.deleted",
        item.project_id,
        actor_id=actor_id,
        payload={"item_id": str(item.id), "kind": item.kind, "title": item.title},
    )
    session.delete(item)
    session.flush()


def _direct_member_ids(
    session: Session, project_id: uuid.UUID, entity_type: str, template: str | None
) -> list[uuid.UUID]:
    """Member ids newest first."""
    cls = PROJECT_MEMBER_TYPES[entity_type]
    stmt = (
        select(EntityRegistry.id)
        .join(cls, cls.id == EntityRegistry.id)  # type: ignore[arg-type]
        .where(cls.project_id == project_id)
        .order_by(EntityRegistry.created_at.desc(), EntityRegistry.id.desc())  # type: ignore[attr-defined]
    )
    if template is not None:
        stmt = stmt.where(Note.template == template)
    return list(session.exec(stmt).all())


def _indirect_member_ids(
    session: Session, project_id: uuid.UUID, entity_type: str, template: str | None
) -> list[uuid.UUID]:
    wafers = select(Wafer.id).where(Wafer.project_id == project_id)
    # Postgres requires DISTINCT's ORDER BY columns in the select list
    # (SQLite does not), so created_at rides along and is dropped below.
    stmt = (
        select(EntityRegistry.id, EntityRegistry.created_at)
        .join(ProvenanceEdge, ProvenanceEdge.src_id == EntityRegistry.id)  # type: ignore[arg-type]
        .where(
            EntityRegistry.entity_type == entity_type,
            ProvenanceEdge.relation == RelationType.REFERS_TO,
            ProvenanceEdge.dst_id.in_(wafers),  # type: ignore[attr-defined]
        )
        .order_by(EntityRegistry.created_at.desc(), EntityRegistry.id.desc())  # type: ignore[attr-defined]
        .distinct()
    )
    if template is not None:
        stmt = stmt.join(Note, Note.id == EntityRegistry.id).where(  # type: ignore[arg-type]
            Note.template == template
        )
    return [row[0] for row in session.exec(stmt).all()]


def project_report(
    session: Session,
    project_id: uuid.UUID,
    *,
    recent_limit: int = 8,
    events_limit: int = 20,
) -> dict:
    _require_project(session, project_id)
    project = get_entity(session, project_id)
    assert project is not None
    lead = get_entity(session, project["lead_id"]) if project.get("lead_id") else None
    goals = [item_to_dict(i) for i in _items_of_kind(session, project_id, "goal")]
    milestones = [
        item_to_dict(i) for i in _items_of_kind(session, project_id, "milestone")
    ]
    today = utcnow().date()
    progress = {
        "goals_done": sum(1 for g in goals if g["done_at"] is not None),
        "goals_total": len(goals),
        "milestones_done": sum(1 for m in milestones if m["done_at"] is not None),
        "milestones_total": len(milestones),
        "overdue_milestones": sum(
            1
            for m in milestones
            if m["done_at"] is None
            and m["target_date"] is not None
            and m["target_date"] < today
        ),
    }
    work: dict[str, dict] = {}
    member_ids: set[uuid.UUID] = {project_id}
    for key, entity_type, template in DIRECT_WORK:
        ids = _direct_member_ids(session, project_id, entity_type, template)
        member_ids.update(ids)
        work[key] = {
            "count": len(ids),
            "recent": [get_entity(session, i) for i in ids[:recent_limit]],
        }
    for key, entity_type, template in INDIRECT_WORK:
        ids = _indirect_member_ids(session, project_id, entity_type, template)
        member_ids.update(ids)
        work[key] = {
            "count": len(ids),
            "recent": [get_entity(session, i) for i in ids[:recent_limit]],
        }
    # Summaries span projects, so their events are not folded into member_ids.
    summary_ids = _result_summary_ids(session, project_id)
    work["result_summary"] = {
        "count": len(summary_ids),
        "recent": [get_entity(session, i) for i in summary_ids[:recent_limit]],
    }
    events = session.exec(
        select(Event)
        .where(Event.entity_id.in_(member_ids))  # type: ignore[attr-defined]
        .order_by(Event.at.desc(), Event.id.desc())  # type: ignore[attr-defined]
        .limit(events_limit)
    ).all()
    return {
        "project": project,
        "lead": lead,
        "goals": goals,
        "milestones": milestones,
        "progress": progress,
        "work": work,
        "events": [e.model_dump() for e in events],
    }
