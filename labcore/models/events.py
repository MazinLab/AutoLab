import uuid
from datetime import datetime

from sqlmodel import Field, SQLModel

from labcore.models.base import JSON_VARIANT, UTCDateTime, utcnow, uuid7


class Event(SQLModel, table=True):
    """Append-only record of every catalog write. Never updated or deleted.

    entity_id is deliberately NOT a foreign key: events must outlive hard
    deletes (the "deleted" event snapshots identity in its payload). actor_id
    keeps its FK so an actor with recorded history cannot be deleted.
    """

    __tablename__ = "event"

    id: uuid.UUID = Field(default_factory=uuid7, primary_key=True)
    at: datetime = Field(default_factory=utcnow, index=True, sa_type=UTCDateTime)
    actor_id: uuid.UUID | None = Field(
        default=None, foreign_key="entity_registry.id", index=True
    )
    action: str = Field(index=True)
    entity_id: uuid.UUID = Field(index=True)
    payload: dict = Field(default_factory=dict, sa_type=JSON_VARIANT)
