import uuid
from contextvars import ContextVar, Token
from datetime import datetime

from fastapi.encoders import jsonable_encoder
from sqlalchemy import and_, or_, tuple_
from sqlmodel import Session, select

from labcore.models.events import Event

# Request-scoped network identity (the person whose connection submitted the
# write), set by the API layer. When it differs from the chosen actor —
# someone deliberately acting as a colleague, or an agent actor launched from
# a person's machine — the event payload records it as "submitted_by".
# Attribution stays exactly what the caller chose; this is metadata, not
# access control.
_submitted_by: ContextVar[uuid.UUID | None] = ContextVar(
    "submitted_by", default=None
)
# The verified network login string, kept separately so a login with NO
# person mapping still leaves an audit trace on the event.
_submitted_login: ContextVar[str | None] = ContextVar(
    "submitted_login", default=None
)


def set_submitted_by(
    person_id: uuid.UUID | None, login: str | None = None
) -> tuple[Token, Token]:
    return _submitted_by.set(person_id), _submitted_login.set(login)


def reset_submitted_by(token: tuple[Token, Token]) -> None:
    _submitted_by.reset(token[0])
    _submitted_login.reset(token[1])


def current_submitted_by() -> uuid.UUID | None:
    return _submitted_by.get()


def _jsonable(payload: dict[str, object]) -> dict[str, object]:
    """Recursively convert an event payload to JSON-native values."""
    return jsonable_encoder(
        payload,
        custom_encoder={
            uuid.UUID: str,
            datetime: datetime.isoformat,
        },
    )


def record_event(
    session: Session,
    action: str,
    entity_id: uuid.UUID,
    actor_id: uuid.UUID | None = None,
    payload: dict | None = None,
) -> None:
    """Add an event to the caller's transaction. Does not commit."""
    payload = dict(payload or {})
    submitted_by = _submitted_by.get()
    if submitted_by is not None and submitted_by != actor_id:
        payload["submitted_by"] = str(submitted_by)
    elif submitted_by is None:
        # A verified network login with no person mapping: keep the login
        # string itself so the submission identity is never silently lost.
        login = _submitted_login.get()
        if login is not None:
            payload["submitted_by_login"] = login
    session.add(
        Event(
            action=action,
            entity_id=entity_id,
            actor_id=actor_id,
            payload=_jsonable(payload),
        )
    )


def recent_events(
    session: Session,
    before: tuple[datetime, uuid.UUID] | None = None,
    limit: int = 50,
    actions: set[str] | None = None,
    actor_id: uuid.UUID | None = None,
    entity_type: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> list[dict]:
    """Newest-first slice of the feed with a strict (at, id) cursor.

    entity_type filters by the entity's registry row, so events of hard
    deleted entities (registry gone) only appear in the unfiltered feed.
    since/until bound the event timestamp (inclusive).
    """
    stmt = (
        select(Event)
        .order_by(Event.at.desc(), Event.id.desc())  # type: ignore[attr-defined]
        .limit(limit)
    )
    if actions:
        stmt = stmt.where(Event.action.in_(actions))
    if since is not None:
        stmt = stmt.where(Event.at >= since)
    if until is not None:
        stmt = stmt.where(Event.at <= until)
    if actor_id is not None:
        stmt = stmt.where(Event.actor_id == actor_id)
    if entity_type is not None:
        from sqlalchemy import String, cast, func, or_

        from labcore.models.base import EntityRegistry

        # Deleted entities have no registry row; their tombstone events
        # snapshot entity_type in the payload, so a filtered feed still
        # shows "deleted wafers".
        bind = session.get_bind()
        if bind is not None and bind.dialect.name == "postgresql":
            payload_type = Event.payload.op("->>")("entity_type")  # type: ignore[attr-defined]
        else:
            payload_type = cast(
                func.json_extract(Event.payload, '$."entity_type"'), String
            )
        stmt = stmt.where(
            or_(
                Event.entity_id.in_(
                    select(EntityRegistry.id).where(
                        EntityRegistry.entity_type == entity_type
                    )
                ),
                payload_type == entity_type,
            )
        )
    if before is not None:
        stmt = stmt.where(tuple_(Event.at, Event.id) < before)
    return [e.model_dump() for e in session.exec(stmt).all()]


def list_events(
    session: Session,
    after: tuple[datetime, uuid.UUID] | None = None,
    limit: int = 100,
    entity_id: uuid.UUID | None = None,
    actions: set[str] | None = None,
) -> list[dict]:
    stmt = select(Event).order_by(Event.at, Event.id).limit(limit)
    if actions:
        stmt = stmt.where(Event.action.in_(actions))
    if entity_id is not None:
        linked_to_entity = and_(
            Event.action == "linked",
            Event.payload["dst_id"].as_string() == str(entity_id),
        )
        stmt = stmt.where(or_(Event.entity_id == entity_id, linked_to_entity))
    if after is not None:
        # Strict row-value comparison: correct pagination even when many
        # events share a timestamp. SQLite (3.15+) and Postgres both
        # support row values.
        stmt = stmt.where(tuple_(Event.at, Event.id) > after)
    return [e.model_dump() for e in session.exec(stmt).all()]
