"""drop the die entity type; devices derive directly from wafers

Revision ID: c8d1f0a37b52
Revises: b7e4c5d2a911
Create Date: 2026-07-20 15:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel
from sqlalchemy import Text
from sqlalchemy.dialects import postgresql


revision: str = "c8d1f0a37b52"
down_revision: Union[str, Sequence[str], None] = "b7e4c5d2a911"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DIE_IDS = "SELECT id FROM entity_registry WHERE entity_type = 'die'"


def _guard_populated() -> None:
    """Refuse to silently destroy die history on a populated database.

    This migration deletes die rows, their edges, and their events. That was
    acceptable for the pre-launch clean-slate reshape; on a database that
    actually holds die records the operator must opt in explicitly after
    archiving (AUTOLAB_ALLOW_DESTRUCTIVE_MIGRATION=1).
    """
    import os

    if os.environ.get("AUTOLAB_ALLOW_DESTRUCTIVE_MIGRATION") == "1":
        return
    count = op.get_bind().execute(
        sa.text("SELECT COUNT(*) FROM entity_registry WHERE entity_type = 'die'")
    ).scalar()
    if count:
        raise RuntimeError(
            f"refusing to drop {count} die record(s) with their edges and "
            "events; archive them first, then re-run with "
            "AUTOLAB_ALLOW_DESTRUCTIVE_MIGRATION=1"
        )


def upgrade() -> None:
    _guard_populated()
    # Purge any die rows and everything referencing them before the registry
    # rows go: provenance edges and events hold foreign keys into the
    # registry. Any surviving device keeps no ancestry through the removed
    # die; relink it to its wafer manually if that history matters.
    op.execute(
        sa.text(
            f"DELETE FROM provenance_edge WHERE src_id IN ({_DIE_IDS}) "
            f"OR dst_id IN ({_DIE_IDS})"
        )
    )
    op.execute(
        sa.text(
            f"DELETE FROM event WHERE entity_id IN ({_DIE_IDS}) "
            f"OR actor_id IN ({_DIE_IDS})"
        )
    )
    op.execute(sa.text("DELETE FROM die"))
    op.execute(
        sa.text("DELETE FROM entity_registry WHERE entity_type = 'die'")
    )
    op.drop_index(op.f("ix_die_name"), table_name="die")
    op.drop_table("die")


def downgrade() -> None:
    # Recreates the table shape only; purged die rows are gone for good.
    op.create_table(
        "die",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "name", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column(
            "description", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column(
            "extra",
            sa.JSON().with_variant(
                postgresql.JSONB(astext_type=Text()), "postgresql"
            ),
            nullable=False,
        ),
        sa.Column(
            "wafer_position",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["id"], ["entity_registry.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_die_name"), "die", ["name"], unique=False)
