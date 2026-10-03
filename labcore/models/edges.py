import uuid
from datetime import datetime
from enum import StrEnum

from sqlmodel import Field, SQLModel, UniqueConstraint

from labcore.models.base import UTCDateTime, utcnow, uuid7


class RelationType(StrEnum):
    DERIVED_FROM = "derived_from"
    SUPERSEDES = "supersedes"
    MEASURED_IN = "measured_in"
    MOUNTED_IN = "mounted_in"
    PERFORMED_ON = "performed_on"
    PRODUCED_BY = "produced_by"
    REFERS_TO = "refers_to"
    PART_OF = "part_of"
    ANNOTATES = "annotates"


class ProvenanceEdge(SQLModel, table=True):
    """Reads as: src RELATION dst  (e.g. device DERIVED_FROM wafer)."""

    __tablename__ = "provenance_edge"
    __table_args__ = (UniqueConstraint("src_id", "dst_id", "relation"),)

    id: uuid.UUID = Field(default_factory=uuid7, primary_key=True)
    src_id: uuid.UUID = Field(foreign_key="entity_registry.id", index=True)
    dst_id: uuid.UUID = Field(foreign_key="entity_registry.id", index=True)
    relation: str = Field(index=True)
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
