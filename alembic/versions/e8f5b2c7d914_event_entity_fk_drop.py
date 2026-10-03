"""Drop the event.entity_id foreign key so events survive hard deletes.

The event feed is append-only audit history. A real DELETE of an entity must
leave its events behind (the "deleted" event snapshots accession/type/name in
its payload), which the FK to entity_registry forbade. actor_id keeps its FK:
an actor with recorded history stays undeletable.

Revision ID: e8f5b2c7d914
Revises: d7e2f4a8b359
Create Date: 2026-07-21
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

import labcore.models.base

revision = "e8f5b2c7d914"
down_revision = "d7e2f4a8b359"
branch_labels = None
depends_on = None


def _event_table(*, entity_fk: bool) -> sa.Table:
    """The event table definition, with or without the entity_id FK.

    Used as batch_alter_table's copy_from on SQLite, where the unnamed FK
    cannot be dropped in place — the table is recreated from this definition.
    """
    metadata = sa.MetaData()
    constraints = (
        [
            sa.ForeignKeyConstraint(
                ["entity_id"],
                ["entity_registry.id"],
                name="fk_event_entity_id",
            )
        ]
        if entity_fk
        else []
    )
    table = sa.Table(
        "event",
        metadata,
        sa.Column("id", sa.Uuid(), primary_key=True, nullable=False),
        sa.Column(
            "at",
            labcore.models.base.UTCDateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "actor_id",
            sa.Uuid(),
            sa.ForeignKey("entity_registry.id"),
            nullable=True,
        ),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        *constraints,
    )
    sa.Index("ix_event_action", table.c.action)
    sa.Index("ix_event_actor_id", table.c.actor_id)
    sa.Index("ix_event_at", table.c.at)
    sa.Index("ix_event_entity_id", table.c.entity_id)
    return table


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.drop_constraint("event_entity_id_fkey", "event", type_="foreignkey")
        return
    with op.batch_alter_table(
        "event", copy_from=_event_table(entity_fk=True)
    ) as batch:
        batch.drop_constraint("fk_event_entity_id", type_="foreignkey")


def downgrade() -> None:
    # Fails if orphan events (from deleted entities) exist — expected: the FK
    # cannot be restored over history it would have forbidden.
    if op.get_bind().dialect.name == "postgresql":
        op.create_foreign_key(
            "event_entity_id_fkey",
            "event",
            "entity_registry",
            ["entity_id"],
            ["id"],
        )
        return
    with op.batch_alter_table(
        "event", copy_from=_event_table(entity_fk=False)
    ) as batch:
        batch.create_foreign_key(
            "fk_event_entity_id",
            "entity_registry",
            ["entity_id"],
            ["id"],
        )
