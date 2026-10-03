import uuid
from datetime import UTC, datetime

import uuid_utils
from sqlalchemy import JSON, DateTime, TypeDecorator
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Dialect
from sqlmodel import Field, SQLModel


def uuid7() -> uuid.UUID:
    """UUIDv7 (time ordered) as a stdlib UUID, usable as a SQLModel default."""
    return uuid.UUID(bytes=uuid_utils.uuid7().bytes)


def utcnow() -> datetime:
    return datetime.now(UTC)


# Type instances are safely shared across tables; Column objects are not.
JSON_VARIANT = JSON().with_variant(JSONB(), "postgresql")


class UTCDateTime(TypeDecorator):
    """Aware-UTC datetimes on every dialect.

    Rejects naive datetimes at bind time (fail fast at the boundary) and
    re-attaches UTC on load: SQLite hands back naive values and Postgres
    hands back the session timezone, so a plain DateTime column cannot
    guarantee the all-timestamps-are-aware-UTC invariant.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(
        self, value: datetime | None, dialect: Dialect
    ) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime rejected: use tz-aware UTC")
        return value.astimezone(UTC)

    def process_result_value(
        self, value: datetime | None, dialect: Dialect
    ) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


class EntityRegistry(SQLModel, table=True):
    """One row per entity of any type: the anchor for identity, accession
    lookup, and provenance edge foreign keys."""

    __tablename__ = "entity_registry"

    id: uuid.UUID = Field(default_factory=uuid7, primary_key=True)
    entity_type: str = Field(index=True)
    accession: str = Field(unique=True, index=True)
    source_key: str | None = Field(default=None, unique=True, index=True)
    version: int = Field(default=0)
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    updated_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    created_by_id: uuid.UUID | None = Field(
        default=None, foreign_key="entity_registry.id", index=True
    )
