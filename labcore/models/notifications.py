"""Notification tables: subscriptions, delivery outbox, dispatcher cursor.

These are plain tables, not catalog entities: a subscription or a queued DM
is not a lab record, gets no accession, and writes no registry row. The
audit trail for sender-initiated notifies is the ``notified`` event.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlmodel import Field, SQLModel

from labcore.models.base import JSON_VARIANT, UTCDateTime, utcnow, uuid7


class NotificationSubscription(SQLModel, table=True):
    """A standing per-person rule: DM me when matching events occur."""

    __tablename__ = "notification_subscription"

    id: uuid.UUID = Field(default_factory=uuid7, primary_key=True)
    person_id: uuid.UUID = Field(
        foreign_key="person.id", ondelete="CASCADE", index=True
    )
    entity_type: str = ""
    action: str = "created"
    # Exact-match constraints on top-level event payload keys; {} matches all.
    filters: dict = Field(default_factory=dict, sa_type=JSON_VARIANT)
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)


class NotificationOutbox(SQLModel, table=True):
    """One queued DM. Delivery retries per-row; failures never block the feed."""

    __tablename__ = "notification_outbox"

    id: uuid.UUID = Field(default_factory=uuid7, primary_key=True)
    person_id: uuid.UUID = Field(
        foreign_key="person.id", ondelete="CASCADE", index=True
    )
    text: str = ""
    status: str = Field(default="pending", index=True)  # pending|sent|dead
    attempts: int = 0
    last_error: str = ""
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    sent_at: datetime | None = Field(default=None, sa_type=UTCDateTime)


class NotificationCursor(SQLModel, table=True):
    """Single-row resume point into the event feed, same (at, id) contract."""

    __tablename__ = "notification_cursor"

    id: int = Field(default=1, primary_key=True)
    at: datetime = Field(sa_type=UTCDateTime)
    event_id: uuid.UUID
