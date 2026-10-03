import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from sqlmodel import select

from app.api.entities import SessionDep
from app.identity import person_for_login, resolve_login
from labcore.events import list_events, recent_events
from labcore.models.base import EntityRegistry
from labcore.models.edges import RelationType
from labcore.models.entities import ENTITY_TYPES
from labcore.models.project_items import ProjectItem

router = APIRouter(prefix="/api")

_TEMPLATES_PATH = Path(__file__).parent.parent / "data" / "templates.json"
with _TEMPLATES_PATH.open(encoding="utf-8") as templates_file:
    TEMPLATES: list[dict[str, object]] = json.load(templates_file)


def _decode_cursor(after: str) -> tuple[datetime, uuid.UUID]:
    try:
        at_raw, id_raw = after.split("|", 1)
        at = datetime.fromisoformat(at_raw)
        event_id = uuid.UUID(id_raw)
    except ValueError:
        raise HTTPException(422, f"malformed cursor: {after!r}")
    if at.utcoffset() is None:
        raise HTTPException(
            422, f"cursor timestamp must include a UTC offset: {after!r}"
        )
    return at.astimezone(UTC), event_id


def _encode_cursor(at: datetime, event_id: uuid.UUID) -> str:
    return f"{at.isoformat()}|{event_id}"


def _coerce_utc(value: datetime | None) -> datetime | None:
    """Date-picker inputs arrive naive; read them as UTC."""
    if value is None:
        return None
    if value.utcoffset() is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


@router.get("/events")
def events(
    session: SessionDep,
    after: str | None = None,
    limit: Annotated[int, Query(ge=0, le=100)] = 100,
) -> dict:
    cursor = _decode_cursor(after) if after else None
    rows = list_events(session, after=cursor, limit=limit)
    next_cursor = (
        _encode_cursor(rows[-1]["at"], rows[-1]["id"]) if rows else None
    )
    return {"events": rows, "next_cursor": next_cursor}


@router.get("/whoami")
def whoami(request: Request, session: SessionDep) -> dict:
    """Network-resolved identity for defaulting the frontend actor picker.

    Never an auth gate: an unresolved or unmapped identity simply means the
    picker starts empty, exactly like today.
    """
    login = resolve_login(request)
    person = person_for_login(session, login) if login else None
    settings = request.app.state.settings
    can_write = bool(login) or not settings.require_identity_for_writes
    return {
        "login": login,
        "person": person,
        "mapped": person is not None,
        "can_write": can_write,
    }


def _entity_summaries(
    session: SessionDep, entity_ids: set[uuid.UUID]
) -> dict[uuid.UUID, dict]:
    if not entity_ids:
        return {}
    registries = session.exec(
        select(EntityRegistry).where(EntityRegistry.id.in_(entity_ids))
    ).all()
    ids_by_type: dict[str, list[uuid.UUID]] = {}
    for registry in registries:
        ids_by_type.setdefault(registry.entity_type, []).append(registry.id)
    names: dict[uuid.UUID, str] = {}
    for entity_type, ids in ids_by_type.items():
        cls = ENTITY_TYPES[entity_type]
        for row_id, row_name in session.exec(
            select(cls.id, cls.name).where(cls.id.in_(ids))
        ).all():
            names[row_id] = row_name
    return {
        registry.id: {
            "id": registry.id,
            "entity_type": registry.entity_type,
            "accession": registry.accession,
            "name": names.get(registry.id, ""),
        }
        for registry in registries
    }


@router.get("/health")
def health(session: SessionDep) -> dict:
    """Liveness/readiness probe: proves the app can reach its database."""
    session.exec(select(EntityRegistry.id).limit(1)).first()
    return {"status": "ok"}


@router.get("/feed")
def feed(
    session: SessionDep,
    before: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    actions: str | None = None,
    actor: uuid.UUID | None = None,
    entity_type: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> dict:
    """Reverse chronological activity feed, hydrated for display.

    Each item carries entity and actor summaries (type, accession, name) so
    the frontend renders one request per page instead of N lookups. actor
    and entity_type narrow the feed ("what did Alice do", "wafer activity");
    since/until bound the date range (naive inputs read as UTC).
    """
    cursor = _decode_cursor(before) if before else None
    wanted = (
        {item.strip() for item in actions.split(",") if item.strip()}
        if actions
        else None
    )
    if entity_type is not None and entity_type not in ENTITY_TYPES:
        raise HTTPException(422, f"unknown entity type {entity_type!r}")
    rows = recent_events(
        session,
        before=cursor,
        limit=limit,
        actions=wanted,
        actor_id=actor,
        entity_type=entity_type,
        since=_coerce_utc(since),
        until=_coerce_utc(until),
    )
    summaries = _entity_summaries(
        session,
        {row["entity_id"] for row in rows}
        | {row["actor_id"] for row in rows if row["actor_id"] is not None},
    )
    items = [
        {
            **row,
            "entity": summaries.get(row["entity_id"]),
            "actor": summaries.get(row["actor_id"])
            if row["actor_id"] is not None
            else None,
        }
        for row in rows
    ]
    next_cursor = (
        _encode_cursor(rows[-1]["at"], rows[-1]["id"])
        if len(rows) == limit
        else None
    )
    return {"items": items, "next_cursor": next_cursor}


def _entity_schema(cls: type) -> dict:
    """model_json_schema, corrected to describe the write contract.

    id is server-assigned (create rejects it), and source_key/links are
    accepted on create although they are not model columns.
    """
    schema = dict(cls.model_json_schema())
    schema["required"] = [
        field for field in schema.get("required", []) if field != "id"
    ]
    properties = dict(schema.get("properties", {}))
    if "id" in properties:
        properties["id"] = {**properties["id"], "readOnly": True}
    properties.setdefault(
        "source_key",
        {
            "type": "string",
            "description": "Idempotency key accepted on create.",
        },
    )
    properties.setdefault(
        "links",
        {
            "type": "array",
            "description": (
                "Outbound edges created atomically with the record: "
                '[{"relation", "dst_id" | "dst_accession"}].'
            ),
        },
    )
    schema["properties"] = properties
    return schema


@router.get("/schema")
def schema() -> dict:
    return {
        "entity_types": {
            etype: _entity_schema(cls) for etype, cls in ENTITY_TYPES.items()
        },
        "relations": [r.value for r in RelationType],
        # Non-entity tables the API exposes; ENTITY_TYPES does not list them.
        "tables": {"project_item": ProjectItem.model_json_schema()},
    }


@router.get("/templates")
def templates() -> list[dict[str, object]]:
    return TEMPLATES
