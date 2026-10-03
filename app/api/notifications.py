"""Subscription CRUD and sender-initiated notify."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Body, HTTPException, Query, Request
from sqlmodel import select

from app.api.entities import ActorDep, SessionDep
from labcore.events import record_event
from labcore.models.base import EntityRegistry
from labcore.models.entities import ENTITY_TYPES
from labcore.models.notifications import (
    NotificationOutbox,
    NotificationSubscription,
)
from labcore.notify import _entity_context, render_message
from labcore.service import get_entity

router = APIRouter(prefix="/api")


def _subscription_dict(sub: NotificationSubscription) -> dict:
    return {
        "id": str(sub.id),
        "person_id": str(sub.person_id),
        "entity_type": sub.entity_type,
        "action": sub.action,
        "filters": sub.filters,
        "created_at": sub.created_at,
    }


def _require_person(session, person_id: uuid.UUID) -> None:
    reg = session.get(EntityRegistry, person_id)
    if reg is None or reg.entity_type != "person":
        raise HTTPException(422, "person_id must reference a person entity")


def _default_person(actor_id: uuid.UUID | None) -> uuid.UUID:
    if actor_id is None:
        raise HTTPException(
            422,
            "person_id required: no network identity resolved this request",
        )
    return actor_id


@router.get("/subscriptions")
def list_subscriptions(
    session: SessionDep,
    actor_id: ActorDep,
    person_id: uuid.UUID | None = Query(default=None),
) -> list[dict]:
    target = person_id or _default_person(actor_id)
    rows = session.exec(
        select(NotificationSubscription)
        .where(NotificationSubscription.person_id == target)
        .order_by(NotificationSubscription.created_at)  # type: ignore[arg-type]
    ).all()
    return [_subscription_dict(row) for row in rows]


@router.post("/subscriptions", status_code=201)
def create_subscription(
    session: SessionDep,
    actor_id: ActorDep,
    body: dict = Body(...),
) -> dict:
    entity_type = body.get("entity_type")
    if entity_type not in ENTITY_TYPES:
        raise HTTPException(422, f"unknown entity_type {entity_type!r}")
    action = body.get("action", "created")
    if action not in {"created", "updated", "deleted", "linked"}:
        raise HTTPException(422, f"unsupported action {action!r}")
    filters = body.get("filters") or {}
    if not isinstance(filters, dict):
        raise HTTPException(422, "filters must be an object")
    raw_person = body.get("person_id")
    person_id = (
        uuid.UUID(str(raw_person))
        if raw_person
        else _default_person(actor_id)
    )
    _require_person(session, person_id)
    subscription = NotificationSubscription(
        person_id=person_id,
        entity_type=entity_type,
        action=action,
        filters=filters,
    )
    session.add(subscription)
    session.flush()
    return _subscription_dict(subscription)


@router.delete("/subscriptions/{subscription_id}", status_code=204)
def delete_subscription(
    session: SessionDep, subscription_id: uuid.UUID
) -> None:
    subscription = session.get(NotificationSubscription, subscription_id)
    if subscription is None:
        raise HTTPException(404, "subscription not found")
    session.delete(subscription)
    session.flush()


@router.post("/notify", status_code=202)
def notify_people(
    request: Request,
    session: SessionDep,
    actor_id: ActorDep,
    body: dict = Body(...),
) -> dict:
    """One-shot DMs about a specific record, chosen by the sender.

    Enqueues outbox rows and records a single ``notified`` audit event in
    the same transaction — "who was told" is on the record.
    """
    raw_ids = body.get("person_ids") or []
    if not isinstance(raw_ids, list) or not raw_ids:
        raise HTTPException(422, "person_ids must be a non-empty list")
    entity_raw = body.get("entity_id")
    if not entity_raw:
        raise HTTPException(422, "entity_id required")
    entity_id = uuid.UUID(str(entity_raw))
    entity = get_entity(session, entity_id)
    if entity is None:
        raise HTTPException(404, "entity not found")
    person_ids = [uuid.UUID(str(raw)) for raw in raw_ids]
    for person_id in person_ids:
        _require_person(session, person_id)

    context = _entity_context(session, entity_id)
    event_row = {
        "action": "ready",
        "actor_id": actor_id,
        "payload": {"entity_type": entity["entity_type"]},
    }
    message = render_message(
        session,
        event_row,
        context,
        request.app.state.settings.public_base_url,
    )
    note = str(body.get("note") or "").strip()
    if note:
        message += f"\n{note}"
    for person_id in person_ids:
        session.add(NotificationOutbox(person_id=person_id, text=message))
    record_event(
        session,
        "notified",
        entity_id,
        actor_id=actor_id,
        payload={
            "entity_type": entity["entity_type"],
            "accession": entity["accession"],
            "recipient_ids": [str(person_id) for person_id in person_ids],
        },
    )
    session.flush()
    return {"queued": len(person_ids)}
