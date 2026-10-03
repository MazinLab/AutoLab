"""drop fab_run and mask_set; fab steps anchor to wafers, masks to designs

Revision ID: a7b4d2e8c135
Revises: f6a3c9e5b028
Create Date: 2026-07-20 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel
from sqlalchemy import Text
from sqlalchemy.dialects import postgresql


revision: str = "a7b4d2e8c135"
down_revision: Union[str, Sequence[str], None] = "f6a3c9e5b028"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _purge_type(entity_type: str) -> None:
    ids = (
        "SELECT id FROM entity_registry "
        f"WHERE entity_type = '{entity_type}'"
    )
    op.execute(
        sa.text(
            f"DELETE FROM provenance_edge WHERE src_id IN ({ids}) "
            f"OR dst_id IN ({ids})"
        )
    )
    op.execute(
        sa.text(
            f"DELETE FROM event WHERE entity_id IN ({ids}) "
            f"OR actor_id IN ({ids})"
        )
    )
    op.execute(sa.text(f"DELETE FROM {entity_type}"))
    op.execute(
        sa.text(
            "DELETE FROM entity_registry "
            f"WHERE entity_type = '{entity_type}'"
        )
    )


def _guard_populated() -> None:
    """Refuse to silently destroy fab_run/mask_set history on a populated DB.

    Acceptable pre-launch; a database actually holding these records requires
    an explicit opt-in after archiving (AUTOLAB_ALLOW_DESTRUCTIVE_MIGRATION=1).
    """
    import os

    if os.environ.get("AUTOLAB_ALLOW_DESTRUCTIVE_MIGRATION") == "1":
        return
    count = op.get_bind().execute(
        sa.text(
            "SELECT COUNT(*) FROM entity_registry "
            "WHERE entity_type IN ('fab_run', 'mask_set')"
        )
    ).scalar()
    if count:
        raise RuntimeError(
            f"refusing to drop {count} fab_run/mask_set record(s) with their "
            "edges and events; archive them first, then re-run with "
            "AUTOLAB_ALLOW_DESTRUCTIVE_MIGRATION=1"
        )


def upgrade() -> None:
    _guard_populated()
    # The FK column must go before the fab_run table it references. Batch
    # mode recreates the table on SQLite; the (fab_run_id, step_index)
    # unique constraint disappears with the column.
    with op.batch_alter_table("fab_step") as batch:
        batch.drop_index(op.f("ix_fab_step_fab_run_id"))
        batch.drop_column("fab_run_id")

    _purge_type("fab_run")
    _purge_type("mask_set")
    op.drop_index(op.f("ix_fab_run_name"), table_name="fab_run")
    op.drop_table("fab_run")
    op.drop_index(op.f("ix_mask_set_name"), table_name="mask_set")
    op.drop_table("mask_set")


def downgrade() -> None:
    for table in ("mask_set", "fab_run"):
        extra_columns = (
            [sa.Column("status", sqlmodel.sql.sqltypes.AutoString(), nullable=False)]
            if table == "fab_run"
            else []
        )
        op.create_table(
            table,
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column(
                "name", sqlmodel.sql.sqltypes.AutoString(), nullable=False
            ),
            sa.Column(
                "description",
                sqlmodel.sql.sqltypes.AutoString(),
                nullable=False,
            ),
            sa.Column(
                "extra",
                sa.JSON().with_variant(
                    postgresql.JSONB(astext_type=Text()), "postgresql"
                ),
                nullable=False,
            ),
            *extra_columns,
            sa.ForeignKeyConstraint(["id"], ["entity_registry.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(op.f(f"ix_{table}_name"), table, ["name"], unique=False)
    with op.batch_alter_table("fab_step") as batch:
        batch.add_column(sa.Column("fab_run_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_fab_step_fab_run_id", "fab_run", ["fab_run_id"], ["id"]
        )
        batch.create_index(op.f("ix_fab_step_fab_run_id"), ["fab_run_id"])
