"""Notification dispatch: match feed events to subscriptions, deliver DMs.

Two decoupled halves, deliberately in separate transactions:

- ``enqueue_matches`` tails the event feed from the persisted cursor and
  copies matches into the outbox IN THE SAME TRANSACTION that advances the
  cursor, so matching is exactly-once.
- ``deliver_pending`` drains the outbox per-row with retries and a dead
  status, so one failing recipient never blocks the feed.

End-to-end semantics are at-least-once; a duplicated DM is harmless.
"""

from __future__ import annotations

import logging
import uuid
from typing import Protocol

from sqlmodel import Session, select

from labcore.events import list_events
from labcore.models.base import EntityRegistry, utcnow
from labcore.models.entities import ENTITY_TYPES, Person
from labcore.models.notifications import (
    NotificationCursor,
    NotificationOutbox,
    NotificationSubscription,
)

logger = logging.getLogger(__name__)

MAX_DELIVERY_ATTEMPTS = 5
_BATCH_LIMIT = 200


class RetryableDeliveryError(Exception):
    """Transient failure (rate limit, 5xx, network): retry next tick."""


class PermanentDeliveryError(Exception):
    """The recipient can never receive this DM (unknown user, no slack id)."""


class NotificationSink(Protocol):
    def send_dm(self, slack_id: str, text: str) -> None: ...


def _entity_context(session: Session, entity_id: uuid.UUID) -> dict:
    """Current entity fields for filter matching and message rendering.

    Returns {} when the entity is gone (hard delete): the event payload
    snapshot is all that remains.
    """
    reg = session.get(EntityRegistry, entity_id)
    if reg is None:
        return {}
    model = ENTITY_TYPES.get(reg.entity_type)
    row = session.get(model, entity_id) if model is not None else None
    context: dict = {
        "entity_type": reg.entity_type,
        "accession": reg.accession,
    }
    if row is not None:
        fields = row.model_dump()
        extra = fields.pop("extra", {}) or {}
        context.update(fields)
        context.update(extra)
        context["accession"] = reg.accession
    return context


def subscription_matches(
    subscription: NotificationSubscription, event: dict, context: dict
) -> bool:
    if subscription.action != event["action"]:
        return False
    entity_type = context.get("entity_type") or event["payload"].get(
        "entity_type"
    )
    if subscription.entity_type != entity_type:
        return False
    merged = {**event["payload"], **context}
    return all(
        merged.get(key) == expected
        for key, expected in subscription.filters.items()
    )


def _actor_name(session: Session, actor_id: uuid.UUID | None) -> str:
    if actor_id is None:
        return ""
    context = _entity_context(session, actor_id)
    name = context.get("name") or context.get("accession") or ""
    return str(name)


def render_message(
    session: Session, event: dict, context: dict, public_url: str
) -> str:
    accession = context.get("accession") or event["payload"].get(
        "accession", ""
    )
    entity_type = context.get("entity_type") or event["payload"].get(
        "entity_type", "record"
    )
    name = str(context.get("name") or "")
    actor = _actor_name(session, event.get("actor_id"))
    parts = [accession or str(entity_type), str(entity_type)]
    if name:
        parts.append(f"'{name}'")
    parts.append(event["action"])
    if actor:
        parts.append(f"by {actor}")
    message = " ".join(str(part) for part in parts if part)
    if accession:
        message += f" — {public_url.rstrip('/')}/e/{accession}"
    return message


def _load_cursor(session: Session) -> NotificationCursor | None:
    return session.get(NotificationCursor, 1)


def _initialize_cursor_at_tail(session: Session) -> NotificationCursor | None:
    """First run: start at the newest event so history is never replayed."""
    from labcore.models.events import Event

    newest = session.exec(
        select(Event).order_by(Event.at.desc(), Event.id.desc()).limit(1)  # type: ignore[attr-defined]
    ).first()
    if newest is None:
        return None
    cursor = NotificationCursor(at=newest.at, event_id=newest.id)
    session.add(cursor)
    session.flush()
    return cursor


def enqueue_matches(session: Session, public_url: str) -> int:
    """Copy subscription matches into the outbox and advance the cursor.

    Flushes only — the caller's single commit makes match + advance atomic.
    """
    cursor = _load_cursor(session)
    if cursor is None:
        _initialize_cursor_at_tail(session)
        return 0
    subscriptions = session.exec(select(NotificationSubscription)).all()
    enqueued = 0
    while True:
        events = list_events(
            session, after=(cursor.at, cursor.event_id), limit=_BATCH_LIMIT
        )
        if not events:
            return enqueued
        for event in events:
            if subscriptions:
                context = _entity_context(session, event["entity_id"])
                message: str | None = None
                for subscription in subscriptions:
                    if not subscription_matches(subscription, event, context):
                        continue
                    if message is None:
                        message = render_message(
                            session, event, context, public_url
                        )
                    session.add(
                        NotificationOutbox(
                            person_id=subscription.person_id, text=message
                        )
                    )
                    enqueued += 1
            cursor.at = event["at"]
            cursor.event_id = event["id"]
        session.add(cursor)
        session.flush()


def deliver_pending(
    session: Session,
    sink: NotificationSink,
    max_attempts: int = MAX_DELIVERY_ATTEMPTS,
) -> tuple[int, int]:
    """Drain pending outbox rows through the sink. Returns (sent, dead)."""
    pending = session.exec(
        select(NotificationOutbox).where(NotificationOutbox.status == "pending")
    ).all()
    sent = dead = 0
    for row in pending:
        person = session.get(Person, row.person_id)
        slack_id = person.slack_id if person is not None else ""
        try:
            if not slack_id:
                raise PermanentDeliveryError(
                    "person has no slack_id on their record"
                )
            sink.send_dm(slack_id, row.text)
        except PermanentDeliveryError as error:
            row.status = "dead"
            row.last_error = str(error)
            dead += 1
        except RetryableDeliveryError as error:
            row.attempts += 1
            row.last_error = str(error)
            if row.attempts >= max_attempts:
                row.status = "dead"
                dead += 1
        else:
            row.status = "sent"
            row.sent_at = utcnow()
            sent += 1
        session.add(row)
    session.flush()
    if sent or dead:
        logger.info("notifications delivered: %d sent, %d dead", sent, dead)
    return sent, dead
