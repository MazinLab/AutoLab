from __future__ import annotations

import uuid
from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import Index
from sqlmodel import Field, SQLModel

from labcore.models.base import UTCDateTime, utcnow, uuid7


class ProjectItemKind(StrEnum):
    GOAL = "goal"
    MILESTONE = "milestone"


class ProjectItem(SQLModel, table=True):
    """A goal or milestone on a project's checklist.

    Not an entity: no accession, no registry row, no lineage. Rows are
    owned by the project and deleted with it. ``position`` is the only
    order (milestones are not sorted by date, so a drag survives reload);
    ``target_date`` is metadata for the overdue flag.
    """

    __tablename__ = "project_item"
    __table_args__ = (
        Index("ix_project_item_project_kind", "project_id", "kind"),
    )

    id: uuid.UUID = Field(default_factory=uuid7, primary_key=True)
    project_id: uuid.UUID = Field(foreign_key="project.id")
    kind: str
    title: str
    position: int = 0
    target_date: date | None = None
    done_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    done_by_id: uuid.UUID | None = Field(
        default=None, foreign_key="entity_registry.id"
    )
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    created_by_id: uuid.UUID | None = Field(
        default=None, foreign_key="entity_registry.id"
    )
